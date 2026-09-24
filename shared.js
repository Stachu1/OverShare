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

function discordError(status, data, statusText) {
  return new Error(`Discord ${status}: ${data?.message || statusText}${data?.code ? ` (code ${data.code})` : ""}`);
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
      request.onerror = () => reject(new Error("Network error while uploading"));
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

async function channelMessages(config) {
  const messages = [];
  let before = null;
  for (let page = 0; page < 100; page++) {
    const batch = await discordRequest(config, "GET", `/channels/${config.channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    messages.push(...batch);
    if (batch.length < 100) break;
    before = batch[batch.length - 1]?.id;
    if (!before) break;
  }
  return messages;
}

function shasFromKeys(keys) {
  return new Set(keys.filter((key) => key.includes(".")).map((key) => key.split(".", 1)[0]));
}

// Finds the manifest and chunk attachments of every transfer whose file token is
// stored. Returns { files } for the list and { found } with chunk URLs. Transfers
// from versions before 3.7 use another format and show as missing (they can
// still be deleted).
async function findTransfers(config, keys) {
  const wanted = shasFromKeys(keys);
  const found = {}, partsBySha = {};
  for (const message of await channelMessages(config)) {
    const content = message.content || "";
    if (content.startsWith(MANIFEST_MARKER)) {
      let manifest = null;
      try { manifest = JSON.parse(content.split("\n", 1)[0].slice(MANIFEST_MARKER.length)); } catch (_) {}
      if (manifest?.v === 2 && wanted.has(manifest.sha) && !found[manifest.sha]) found[manifest.sha] = { manifest, parts: {} };
    }
    for (const attachment of message.attachments || []) {
      const match = (attachment.filename || "").match(/^([^.]+)\.(\d+)$/);
      if (match && wanted.has(match[1])) (partsBySha[match[1]] ??= {})[Number(match[2])] = { url: attachment.url, size: attachment.size || 0 };
    }
  }
  const files = [...wanted].sort().map((sha) => {
    const item = found[sha];
    // The manifest is posted last, so chunks without one are a send that never finished.
    const orphanChunks = Object.keys(partsBySha[sha] || {}).length;
    if (!item) return { sha, name: orphanChunks ? "Unfinished upload" : "Unknown transfer", available: false, manifestFound: false, missingFile: !orphanChunks, missingChunks: null, orphanChunks };
    item.parts = partsBySha[sha] || {};
    const total = Number(item.manifest.total);
    let have = 0;
    for (let index = 1; index <= total; index++) if (item.parts[index]) have++;
    return { ...item.manifest, available: have === total, manifestFound: true, missingFile: false, missingChunks: total - have };
  });
  return { files, found };
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
