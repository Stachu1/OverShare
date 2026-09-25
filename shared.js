"use strict";

// Helpers shared by the popup (popup.js) and the transfer engine (engine.js).
// Discord calls go straight to the bot API; rules.json rewrites the User-Agent
// on them, because Discord rejects bot-token requests with a browser User-Agent.

const API = "https://discord.com/api/v10";
const MANIFEST_MARKER = "OVERSHARE|";
const CHUNK_BYTES = 20 * 1024 * 1024;

// A transfer is one zip, streamed and cut into pieces that are each encrypted with
// AES-GCM and uploaded as "<id>.<n>". The IV holds the piece number and the
// authenticated data holds the transfer ID, the number and whether it is the
// last piece, so a changed, reordered, swapped or missing piece fails to decrypt.
// The manifest is posted last, once the piece count is known.
const PLAIN_CHUNK_BYTES = CHUNK_BYTES - 16; // AES-GCM adds a 16-byte tag
function chunkIv(prefix, index) {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(8, index);
  return iv;
}
function chunkAad(sha, index, final) { return new TextEncoder().encode(`OVERSHARE2|${sha}|${index}|${final ? 1 : 0}`); }
// Transfer IDs are random. Transfers sent before 4.8 have 64-character IDs and
// no manifest tag.
const ID_BYTES = 8;
const LEGACY_ID_LENGTH = 64;
// The manifest's tag is an AES-GCM tag, made with the file key, over the details a
// download relies on, so a manifest with a changed name, size or chunk count is
// refused. It uses IV number 0, which no chunk uses.
function manifestAad(manifest) {
  return new TextEncoder().encode(JSON.stringify(["OVERSHARE-MANIFEST", manifest.sha, manifest.name, manifest.kind, manifest.originalSize, manifest.encryptedSize, manifest.total]));
}
async function manifestTag(manifest, key) {
  const tag = await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(base64urlDecode(manifest.iv), 0), additionalData: manifestAad(manifest) }, key, new Uint8Array(0));
  return base64urlEncode(new Uint8Array(tag));
}
async function verifyManifest(manifest, key) {
  const failed = new Error("the file's details failed their integrity check (wrong file token, or the manifest was changed)");
  if (!manifest.tag) { if (manifest.sha.length === LEGACY_ID_LENGTH) return; throw failed; }
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(base64urlDecode(manifest.iv), 0), additionalData: manifestAad(manifest) }, key, base64urlDecode(manifest.tag));
  } catch (error) {
    if (error.name === "OperationError") throw failed;
    throw error;
  }
}
// Each configuration (a bot token and channel) keeps its own file tokens, stored
// as "<config id>:<transfer id>.symmetricKey", and the token of its latest send
// as "<config id>:lastFileToken".
function tokenKey(configId, sha) { return `${configId}:${sha}.symmetricKey`; }
function lastTokenKey(configId) { return `${configId}:lastFileToken`; }
// The file tokens ("<id>.<key>") stored for one configuration.
function configTokens(data, configId) {
  const prefix = `${configId}:`, suffix = ".symmetricKey";
  return Object.entries(data)
    .filter(([name, value]) => configId && name.startsWith(prefix) && name.endsWith(suffix) && typeof value === "string")
    .map(([name, value]) => `${name.slice(prefix.length, -suffix.length)}.${value}`);
}
function importChunkKey(encodedKey, usage) { return crypto.subtle.importKey("raw", base64urlDecode(encodedKey), "AES-GCM", false, [usage]); }
// Popup <-> engine messages. A BroadcastChannel (unlike chrome.runtime
// messaging) can carry Blobs and directory handles.
const ENGINE_CHANNEL = "overshare";

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function base64urlEncode(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64urlDecode(value) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(-value.length & 3));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function formatDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return "…";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

// Speed over the last few seconds, so it follows the current rate rather than
// the average since the start.
class TransferMeter {
  constructor(totalBytes, windowMs = 5000) { this.total = totalBytes; this.windowMs = windowMs; this.samples = [{ t: performance.now(), bytes: 0 }]; }
  update(bytesDone) {
    const now = performance.now();
    this.samples.push({ t: now, bytes: bytesDone });
    while (this.samples.length > 2 && now - this.samples[1].t > this.windowMs) this.samples.shift();
    const first = this.samples[0], elapsed = (now - first.t) / 1000;
    const speed = elapsed >= 0.5 ? (bytesDone - first.bytes) / elapsed : 0;
    return { speed, eta: speed > 0 ? (this.total - bytesDone) / speed : null };
  }
}
function transferStats({ speed, eta }) { return speed ? `${humanSize(speed)}/s · ${formatDuration(eta)} left` : "measuring speed…"; }

// Discord's own messages can start with the status again ("401: Unauthorized"), which is dropped.
function discordError(status, data, statusText) {
  const text = String(data?.message || statusText).replace(/^\d+:\s*/, "");
  return Object.assign(new Error(`Discord ${status}: ${text}${data?.code ? ` (code ${data.code})` : ""}`), { status });
}
function parseJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }

// config = { token, channelId }. Retries on rate limits; a DELETE of a missing
// message counts as done.
async function discordRequest(config, method, path, { json, form, signal } = {}) {
  if (!config?.token || !config?.channelId) throw new Error("Set the bot token and channel ID first");
  for (;;) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { "Authorization": `Bot ${config.token}`, ...(json ? { "Content-Type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : form,
      signal,
    });
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      await new Promise((resolve) => setTimeout(resolve, Number(data.retry_after || 1) * 1000));
      continue;
    }
    if (method === "DELETE" && response.status === 404) return null;
    if (!response.ok) throw discordError(response.status, await response.json().catch(() => null), response.statusText);
    return response.status === 204 ? null : response.json();
  }
}

// Multipart POST through XMLHttpRequest, since fetch can't report upload
// progress. onProgress receives the bytes of the body sent so far.
async function discordUpload(config, path, form, { signal, onProgress } = {}) {
  for (;;) {
    const xhr = await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${API}${path}`);
      request.setRequestHeader("Authorization", `Bot ${config.token}`);
      request.upload.onprogress = (event) => onProgress?.(event.loaded);
      request.onload = () => resolve(request);
      request.onerror = () => reject(Object.assign(new Error("Network error while uploading"), { network: true }));
      request.onabort = () => reject(new DOMException("Upload canceled", "AbortError"));
      if (signal?.aborted) return reject(new DOMException("Upload canceled", "AbortError"));
      signal?.addEventListener("abort", () => request.abort(), { once: true });
      request.send(form);
    });
    const data = parseJson(xhr.responseText);
    if (xhr.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, Number(data?.retry_after || 1) * 1000));
      continue;
    }
    if (xhr.status < 200 || xhr.status >= 300) throw discordError(xhr.status, data, xhr.statusText);
    return data;
  }
}

const MESSAGE_PAGE = 100;
const MAX_PAGES = 100; // the history read is capped at the latest 10,000 messages

function messagePage(config, before) {
  return discordRequest(config, "GET", `/channels/${config.channelId}/messages?limit=${MESSAGE_PAGE}${before ? `&before=${before}` : ""}`);
}
async function channelMessages(config) {
  const messages = [];
  let before = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await messagePage(config, before);
    messages.push(...batch);
    if (batch.length < MESSAGE_PAGE) break;
    before = batch[batch.length - 1]?.id;
    if (!before) break;
  }
  return messages;
}

function shasFromKeys(keys) {
  return new Set(keys.filter((key) => key.includes(".")).map((key) => key.split(".", 1)[0]));
}

// Walks the channel newest-first, a page of messages at a time, and hands out the
// transfers whose file tokens are stored, newest first. Chunks are always older
// than their manifest, and the manifest names the message of chunk 1, so a
// transfer is handed out as soon as all its chunks are found or the walk has gone
// past chunk 1. Only as much history is read as the files asked for need.
// Transfers without a manifest (unfinished or deleted) can only be known once the
// whole history is read, so they come last.
class TransferScanner {
  constructor(config, keys) {
    this.config = config;
    this.wanted = shasFromKeys(keys);
    this.queue = []; // { manifest, sentAt } with a manifest found, newest first, not handed out yet
    this.parts = {}; // sha -> { chunk number: { url, size } }
    this.seen = new Set(); // shas whose manifest was found
    this.before = null;
    this.pages = 0;
    this.ended = !this.wanted.size; // no more history to read, or none needed
    this.leftoversGiven = false;
  }
  get done() { return this.ended && !this.queue.length && this.leftoversGiven; }
  async readPage() {
    const batch = await messagePage(this.config, this.before);
    for (const message of batch) {
      const content = message.content || "";
      if (content.startsWith(MANIFEST_MARKER)) {
        let manifest = null;
        try { manifest = JSON.parse(content.split("\n", 1)[0].slice(MANIFEST_MARKER.length)); } catch (_) {}
        if (manifest?.v === 3 && this.wanted.has(manifest.sha) && !this.seen.has(manifest.sha)) {
          this.seen.add(manifest.sha);
          this.queue.push({ manifest, sentAt: Date.parse(message.timestamp) || 0 });
        }
      }
      for (const attachment of message.attachments || []) {
        const match = (attachment.filename || "").match(/^([^.]+)\.(\d+)$/);
        if (match && this.wanted.has(match[1])) (this.parts[match[1]] ??= {})[Number(match[2])] = { url: attachment.url, size: attachment.size || 0 };
      }
    }
    this.pages++;
    if (batch.length) this.before = batch[batch.length - 1].id;
    if (batch.length < MESSAGE_PAGE || this.pages >= MAX_PAGES) this.ended = true;
  }
  chunksFound(manifest) {
    const parts = this.parts[manifest.sha] || {};
    let have = 0;
    for (let index = 1; index <= Number(manifest.total); index++) if (parts[index]) have++;
    return have;
  }
  ready({ manifest }) {
    if (this.ended || this.chunksFound(manifest) === Number(manifest.total)) return true;
    return !!this.before && BigInt(this.before) <= BigInt(manifest.firstId);
  }
  describe({ manifest, sentAt }) {
    const total = Number(manifest.total), have = this.chunksFound(manifest);
    return { ...manifest, sentAt, parts: this.parts[manifest.sha] || {}, available: have === total, manifestFound: true, missingFile: false, missingChunks: total - have };
  }
  // Returns up to count more files for the list, newest first.
  async next(count) {
    const files = [];
    for (;;) {
      while (files.length < count && this.queue.length && this.ready(this.queue[0])) files.push(this.describe(this.queue.shift()));
      if (files.length >= count || this.ended) break;
      // Once every wanted manifest is found and handed out, older history can't add a file.
      if (!this.queue.length && this.seen.size === this.wanted.size) { this.ended = true; break; }
      await this.readPage();
    }
    if (this.ended && !this.queue.length && !this.leftoversGiven && files.length < count) {
      this.leftoversGiven = true;
      for (const sha of this.wanted) {
        if (this.seen.has(sha)) continue;
        // The manifest is posted last, so chunks without one are a send that never finished.
        const orphanChunks = Object.keys(this.parts[sha] || {}).length;
        files.push({ sha, name: orphanChunks ? "Unfinished upload" : "Unknown transfer", available: false, manifestFound: false, missingFile: !orphanChunks, missingChunks: null, orphanChunks });
      }
    }
    return files;
  }
}

// Finds one transfer's manifest and chunks, reading no further back than it needs.
async function findTransfer(config, key) {
  const scanner = new TransferScanner(config, [key]);
  const [file] = await scanner.next(1);
  return file?.manifestFound ? { manifest: file, parts: file.parts } : null;
}

// Deletes every message that mentions one of the SHAs or carries one of their
// chunks. onProgress receives the number deleted so far.
async function deleteTransfers(config, shas, onProgress) {
  const wanted = new Set(shas);
  if (!wanted.size) return 0;
  let deleted = 0;
  for (const message of await channelMessages(config)) {
    const matches = [...wanted].some((sha) => (message.content || "").includes(sha))
      || (message.attachments || []).some((a) => (a.filename || "").includes(".") && wanted.has(a.filename.slice(0, a.filename.lastIndexOf("."))));
    if (matches) {
      await discordRequest(config, "DELETE", `/channels/${config.channelId}/messages/${message.id}`);
      deleted++;
      onProgress?.(deleted);
    }
  }
  return deleted;
}

// Yields each decrypted piece in order, so only one is in memory at a time.
// onProgress receives (bytesDone, totalBytes) of the encrypted download.
async function* decryptChunks(item, encodedKey, onProgress) {
  const { sha, iv, total: totalText, encryptedSize } = item.manifest;
  const total = Number(totalText);
  const key = await importChunkKey(encodedKey, "decrypt");
  await verifyManifest(item.manifest, key);
  const prefix = base64urlDecode(iv);
  let received = 0;
  for (let index = 1; index <= total; index++) {
    const part = item.parts[index];
    if (!part) throw new Error("not all chunks are available");
    const response = await fetch(part.url);
    if (!response.ok) throw new Error(`chunk ${index} download failed: HTTP ${response.status}`);
    const pieces = [];
    let length = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value); length += value.length; received += value.length;
      onProgress(received, Math.max(Number(encryptedSize) || 0, received));
    }
    const ciphertext = new Uint8Array(length);
    let offset = 0;
    for (const piece of pieces) { ciphertext.set(piece, offset); offset += piece.length; }
    pieces.length = 0;
    try {
      yield new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(prefix, index), additionalData: chunkAad(sha, index, index === total) }, key, ciphertext));
    } catch (error) {
      if (error.name === "OperationError") throw new Error(`chunk ${index} failed its integrity check (wrong file token, or the chunk was changed)`);
      throw error;
    }
  }
}
