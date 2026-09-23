"use strict";

// Transfer engine. Runs in an offscreen document (created by background.js) so
// sends and downloads keep going after the popup closes. The popup hands it jobs
// over a BroadcastChannel and renders the state it pushes back.

const chan = new BroadcastChannel(ENGINE_CHANNEL);

// Everything the popup needs to render. Pushed whole on every change (it's tiny).
const state = {
  send: null,     // { active, name, percent, outcome: null|"ok"|"err"|"canceled" }
  download: null, // { active, id, name, percent, outcome }
  status: null,   // { msg, kind, seq } — latest status line
};
let statusSeq = 0;

function push() { chan.postMessage({ type: "state", state }); }
// Progress fires many times a second; coalesce those pushes to ~10/s.
let pushTimer = null;
function pushSoon() {
  if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; push(); }, 100);
}
function setStatus(msg, kind = "info", soon = false) {
  state.status = { msg, kind, seq: ++statusSeq };
  soon ? pushSoon() : push();
}

function abortError() {
  const e = new Error("Canceled");
  e.name = "AbortError";
  return e;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

// --- Retries ---
// Rate limits (429) wait the time Discord asks for and don't count as failures.
// Network errors, timeouts and server errors (5xx) back off 1, 2, 4, 8, 16 s.
// Anything else (bad token, missing channel, too large…) fails straight away.
const MAX_RETRIES = 5;
function isRetryable(err) {
  return err.status == null || err.status === 408 || err.status >= 500;
}
async function withRetry(label, fn, signal) {
  let failures = 0;
  for (;;) {
    try { return await fn(); }
    catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw abortError();
      if (e.status === 429) {
        const wait = e.retryAfter ?? 1;
        setStatus(`Rate limited — waiting ${wait.toFixed(1)}s…`);
        await sleep((wait + 0.5) * 1000, signal);
        continue;
      }
      if (isRetryable(e) && failures < MAX_RETRIES) {
        failures++;
        const wait = 2 ** (failures - 1);
        setStatus(`${label}: ${e.message} — retry ${failures}/${MAX_RETRIES} in ${wait}s…`);
        await sleep(wait * 1000, signal);
        continue;
      }
      throw e;
    }
  }
}

// Turn an HTTP failure into an error carrying .status (and .retryAfter on 429).
function httpError(status, body, retryAfterHeader) {
  let msg = `HTTP ${status}${body && body.message ? " — " + body.message : ""}`;
  if (status === 413) msg = "Chunk too large for this account's upload limit — lower Chunk size.";
  const err = new Error(msg);
  err.status = status;
  if (status === 429) {
    err.retryAfter = body && body.retry_after != null ? Number(body.retry_after)
      : Number(retryAfterHeader) || 1;
  }
  return err;
}

// ============================ SEND ============================

// POST one message carrying one or more attachments (blobs[]/names[]).
// XHR (not fetch) so we get real upload progress.
function uploadBundle(token, channelId, blobs, names, content, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: content || "" }));
    blobs.forEach((blob, i) => form.append(`files[${i}]`, blob, names[i]));

    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);

    xhr.open("POST", `${API}/channels/${channelId}/messages`);
    xhr.setRequestHeader("Authorization", token);
    xhr.upload.addEventListener("progress", (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded); });
    xhr.addEventListener("load", () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      reject(httpError(xhr.status, body, xhr.getResponseHeader("retry-after")));
    });
    xhr.addEventListener("error", () => { done(); reject(new Error("Network error")); });
    xhr.addEventListener("timeout", () => { done(); reject(new Error("Timed out")); });
    xhr.addEventListener("abort", () => { done(); reject(abortError()); });
    xhr.send(form);
  });
}

// The transfer's first message: a human line + a machine-readable manifest.
function buildManifestContent(manifest, note) {
  const human =
    `📦 OverShare: ${manifest.name}${manifest.kind === "folder" ? "/ (folder)" : ""}\n` +
    `${humanSize(manifest.originalSize)} → ${humanSize(manifest.zippedSize)} zipped · ${manifest.total} chunk(s)\n` +
    `SHA-256 ${manifest.sha256}`;
  const body = note ? `${human}\n\n${note}` : human;
  // Wrap in a spoiler + code block. The manifest JSON is the last line, so the
  // closing "```||" sits on its own line and never touches the JSON.
  return "||```text\n" + body + `\n${MANIFEST_MARKER}${JSON.stringify(manifest)}\n` + "```||";
}

let sendAbort = null;

async function runSend(job) {
  if (state.send?.active) return; // one send at a time
  const { token, channelId, note, blob, chunkBytes, perMsg, meta } = job;
  const total = Math.max(1, Math.ceil(blob.size / chunkBytes));

  // Per-message plan of chunk blobs/names (chunks named "<base>.<i>_<total>").
  const plan = [];
  for (let gi = 0; gi < total;) {
    const blobs = [], names = [];
    for (let k = 0; k < perMsg && gi < total; k++, gi++) {
      blobs.push(blob.slice(gi * chunkBytes, Math.min(blob.size, (gi + 1) * chunkBytes)));
      names.push(`${meta.base}.${gi + 1}_${total}`);
    }
    plan.push({ blobs, names });
  }
  const manifest = {
    v: 1, kind: meta.kind, name: meta.name, base: meta.base, total,
    originalSize: meta.originalSize, zippedSize: meta.zippedSize,
    sha256: meta.sha256, entries: meta.entries,
  };

  sendAbort = new AbortController();
  const signal = sendAbort.signal;
  state.send = { active: true, name: meta.name, percent: 0, outcome: null };
  try {
    // 1) Manifest message first (also carries the optional note).
    setStatus("Sending manifest…");
    await withRetry("Manifest", () =>
      uploadBundle(token, channelId, [], [], buildManifestContent(manifest, note), null, signal), signal);

    // 2) Chunk messages.
    let sent = 0;
    for (let m = 0; m < plan.length; m++) {
      const { blobs, names } = plan[m];
      const bundleBytes = blobs.reduce((a, b) => a + b.size, 0);
      await withRetry(`Message ${m + 1}/${plan.length}`, () =>
        uploadBundle(token, channelId, blobs, names, "", (loaded) => {
          const overall = Math.min(blob.size, sent + loaded);
          state.send.percent = Math.round((overall / blob.size) * 100);
          setStatus(`Message ${m + 1}/${plan.length} — ${humanSize(overall)} / ${humanSize(blob.size)}`, "info", true);
        }, signal), signal);
      sent += bundleBytes;
    }
    state.send.percent = 100;
    state.send.outcome = "ok";
    setStatus(`Sent "${meta.name}" — ${total} chunk(s) in ${plan.length} message(s) ✓`, "ok");
  } catch (err) {
    if (err.name === "AbortError") {
      state.send.outcome = "canceled";
      setStatus("Send canceled. Anything already posted shows as an incomplete transfer.", "info");
    } else {
      state.send.outcome = "err";
      setStatus(err.message, "err");
    }
  } finally {
    state.send.active = false;
    sendAbort = null;
    push();
  }
}

// ========================== DOWNLOAD ==========================

// Best-effort MIME from the filename extension. Without a type on the blob,
// Chrome sniffs it as text and appends ".txt" to the saved file.
const MIME = {
  mp4: "video/mp4", mkv: "video/x-matroska", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  gz: "application/gzip", tar: "application/x-tar", exe: "application/x-msdownload", iso: "application/x-iso9660-image",
  json: "application/json", txt: "text/plain", csv: "text/csv", md: "text/markdown",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function inferMime(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return MIME[ext] || "application/octet-stream";
}

// Fetch one chunk, streaming so we can report progress.
async function fetchPart(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw httpError(res.status, null, res.headers.get("retry-after"));
  const reader = res.body.getReader();
  const pieces = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pieces.push(value);
    got += value.length;
    onProgress(got);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  return out;
}

// Save bytes via the downloads API (background.js makes the actual call).
async function saveBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: inferMime(filename) }));
  const res = await chrome.runtime.sendMessage({ target: "background", type: "download", url, filename, saveAs: true });
  // Generous delay: the Save As dialog may stay open a while before Chrome reads it.
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  if (res && res.error) throw new Error(res.error);
}

// Write unzipped entries into a chosen directory, recreating subfolders.
async function saveFolderToDisk(dirHandle, files, names) {
  for (const name of names) {
    const segs = name.split("/");
    const fileSeg = segs.pop();
    let cur = dirHandle;
    for (const seg of segs) if (seg) cur = await cur.getDirectoryHandle(seg, { create: true });
    const fh = await cur.getFileHandle(fileSeg, { create: true });
    const w = await fh.createWritable();
    await w.write(files[name]);
    await w.close();
  }
}

// Fetch every chunk, reassemble, verify the SHA, then unzip and save.
async function runDownload(job) {
  if (state.download?.active) return; // one download at a time
  const { id, name, manifest, parts, dirHandle } = job;
  const totalBytes = parts.reduce((a, p) => a + (p.size || 0), 0) || 1;
  state.download = { active: true, id, name, percent: 0, outcome: null };
  try {
    const chunks = [];
    let done = 0;
    for (let i = 0; i < parts.length; i++) {
      const buf = await withRetry(`Part ${i + 1}/${parts.length}`, () =>
        fetchPart(parts[i].url, (got) => {
          const overall = Math.min(totalBytes, done + got);
          state.download.percent = Math.round((overall / totalBytes) * 100);
          setStatus(`Downloading "${name}" — part ${i + 1}/${parts.length} · ${humanSize(overall)} / ${humanSize(totalBytes)}`, "info", true);
        }));
      chunks.push(buf);
      done += buf.length;
    }
    const bytes = new Uint8Array(done);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }

    // Integrity check against the manifest SHA-256.
    let verified = null;
    if (manifest && manifest.sha256) {
      setStatus(`Verifying "${name}"…`);
      verified = (await sha256hex(bytes)) === manifest.sha256;
      if (!verified) throw new Error(`Integrity check failed for "${name}" (SHA mismatch).`);
    }

    const zipName = name.replace(/\/$/, "") + ".zip";
    const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4B; // "PK"
    if (isZip) {
      let files;
      try { files = fflate.unzipSync(bytes); }
      catch (e) { throw new Error("Unzip failed: " + e.message); }
      const names = Object.keys(files).filter((n) => !n.endsWith("/"));
      if (!names.length) throw new Error("Archive is empty.");
      if (dirHandle) {
        // The folder was picked in the popup; if its permission didn't carry
        // over (or writing fails), hand back the .zip instead of losing it.
        let wrote = false;
        try {
          if ((await dirHandle.queryPermission({ mode: "readwrite" })) === "granted") {
            await saveFolderToDisk(dirHandle, files, names);
            wrote = true;
          }
        } catch (_) {}
        if (!wrote) await saveBytes(bytes, zipName);
      } else if (names.length === 1) {
        await saveBytes(files[names[0]], names[0].split("/").pop()); // single file
      } else {
        await saveBytes(bytes, zipName); // multi-file archive, no folder destination
      }
    } else {
      await saveBytes(bytes, name); // legacy / non-zip payloads
    }

    state.download.percent = 100;
    state.download.outcome = "ok";
    setStatus(`Saved "${name}"${verified === true ? " · 🔒 SHA verified" : ""} ✓`, "ok");
  } catch (err) {
    state.download.outcome = "err";
    setStatus(err.message || String(err), "err");
  } finally {
    state.download.active = false;
    push();
  }
}

// ========================== MESSAGES ==========================

chan.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === "hello") push();
  else if (msg.type === "send") runSend(msg.job);
  else if (msg.type === "cancelSend") sendAbort?.abort();
  else if (msg.type === "download") runDownload(msg.job);
};
push(); // announce ourselves in case the popup asked before we loaded
