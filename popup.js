"use strict";

const API = "https://discord.com/api/v10";
const MAX_ATTACHMENTS = 10; // Discord's hard cap per message

const els = {
  token: document.getElementById("token"),
  detect: document.getElementById("detect"),
  channel: document.getElementById("channel"),
  // tabs
  tabSend: document.getElementById("tabSend"),
  tabDownload: document.getElementById("tabDownload"),
  sendPanel: document.getElementById("sendPanel"),
  downloadPanel: document.getElementById("downloadPanel"),
  // send
  chunk: document.getElementById("chunk"),
  chunkInfo: document.getElementById("chunkInfo"),
  maxmsg: document.getElementById("maxmsg"),
  file: document.getElementById("file"),
  drop: document.getElementById("drop"),
  dropLabel: document.getElementById("dropLabel"),
  note: document.getElementById("note"),
  send: document.getElementById("send"),
  progress: document.getElementById("progress"),
  bar: document.getElementById("bar"),
  // download
  fileList: document.getElementById("fileList"),
  loadOlderWrap: document.getElementById("loadOlderWrap"),
  // shared
  status: document.getElementById("status"),
  version: document.getElementById("version"),
};

// Show the extension version (from the manifest) in the header.
els.version.textContent = "v" + chrome.runtime.getManifest().version;

let selectedFile = null;

// --- Restore/persist settings ---
chrome.storage.local.get(["token", "channel", "chunkMB", "maxMsgMB"], (data) => {
  if (data.token) els.token.value = data.token;
  if (data.channel) els.channel.value = data.channel;
  if (data.chunkMB) els.chunk.value = data.chunkMB;
  if (data.maxMsgMB) els.maxmsg.value = data.maxMsgMB;
  refreshSendState();
  updateChunkInfo();
  // Restore is done — if the popup opened on a Discord tab, auto-fill from it;
  // otherwise keep the values just restored.
  detectFromTab(true);
});
els.token.addEventListener("change", () => chrome.storage.local.set({ token: els.token.value.trim() }));
els.channel.addEventListener("change", () => chrome.storage.local.set({ channel: els.channel.value.trim() }));
els.chunk.addEventListener("change", () => chrome.storage.local.set({ chunkMB: els.chunk.value.trim() }));
els.maxmsg.addEventListener("change", () => chrome.storage.local.set({ maxMsgMB: els.maxmsg.value.trim() }));

// --- Helpers ---
function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
function setStatus(msg, kind = "info") {
  els.status.textContent = msg;
  els.status.className = `status ${kind}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Sound effects (synthesized, no asset files) ---
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, { type = "sine", gain = 0.05, delay = 0 } = {}) {
  try {
    const ctx = ac();
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (_) { /* audio unavailable — stay silent */ }
}
// A short filtered noise burst — reads as a real "click", not a beep.
function noiseBurst(dur, { gain = 0.08, hp = 1800, lp = 8000 } = {}) {
  try {
    const ctx = ac();
    const t0 = ctx.currentTime;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hpf = ctx.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = hp;
    const lpf = ctx.createBiquadFilter(); lpf.type = "lowpass"; lpf.frequency.value = lp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(hpf).connect(lpf).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.01);
  } catch (_) { /* audio unavailable — stay silent */ }
}
const sfx = {
  hover: () => tone(1200, 0.02, { type: "sine", gain: 0.008 }), // barely-there tick
  click: () => noiseBurst(0.022, { gain: 0.12, hp: 2200, lp: 9000 }), // crisp snap
  // ascending chime on a successful send
  send: () => { tone(523, 0.12, { gain: 0.05 }); tone(659, 0.12, { gain: 0.05, delay: 0.1 }); tone(784, 0.16, { gain: 0.05, delay: 0.2 }); },
  // gentle two-note "arrived" cue on a completed download
  download: () => { tone(784, 0.12, { gain: 0.05 }); tone(523, 0.18, { gain: 0.05, delay: 0.12 }); },
};

// Delegated so it covers the dynamically-created Download buttons too.
let lastHover = null;
document.addEventListener("mouseover", (e) => {
  const b = e.target.closest("button");
  if (b && b !== lastHover) { lastHover = b; sfx.hover(); }
  else if (!b) { lastHover = null; }
});
document.addEventListener("click", (e) => { if (e.target.closest("button")) sfx.click(); }, true);

// Split math + message packing, shared by the readout and the sender.
function chunkPlan(fileSize) {
  const chunkMB = parseFloat(els.chunk.value) || 8;
  const maxMsgMB = parseFloat(els.maxmsg.value) || chunkMB;
  const chunkBytes = Math.max(1, Math.floor(chunkMB * 1024 * 1024));
  const maxMsgBytes = Math.max(chunkBytes, Math.floor(maxMsgMB * 1024 * 1024));
  const total = Math.max(1, Math.ceil(fileSize / chunkBytes));
  const perMsg = Math.max(1, Math.min(MAX_ATTACHMENTS, Math.floor(maxMsgBytes / chunkBytes)));
  const messages = Math.ceil(total / perMsg);
  return { chunkBytes, total, perMsg, messages };
}
function updateChunkInfo() {
  if (!selectedFile) { els.chunkInfo.textContent = ""; return; }
  const { total, messages } = chunkPlan(selectedFile.size);
  if (total === 1) { els.chunkInfo.textContent = "→ 1 chunk"; return; }
  const msgLabel = messages === 1 ? "1 message" : `${messages} messages`;
  els.chunkInfo.textContent = `→ ${total} chunks · ${msgLabel}`;
}
function refreshSendState() {
  els.send.disabled = !(selectedFile && els.token.value.trim() && els.channel.value.trim());
}
function pickFile(file) {
  if (!file) return;
  selectedFile = file;
  els.drop.classList.add("has-file");
  els.dropLabel.innerHTML =
    `<div class="name">${file.name}</div><div class="size">${humanSize(file.size)}</div>`;
  refreshSendState();
  updateChunkInfo();
}

// --- Tabs ---
function showTab(which) {
  const send = which === "send";
  els.tabSend.classList.toggle("active", send);
  els.tabDownload.classList.toggle("active", !send);
  els.sendPanel.classList.toggle("active", send);
  els.downloadPanel.classList.toggle("active", !send);
  if (!send) refreshList(true); // auto-load the list when entering Download
}
els.tabSend.addEventListener("click", () => showTab("send"));
els.tabDownload.addEventListener("click", () => showTab("download"));

// Keep both tabs the same height so switching doesn't resize the popup.
// Measured once after layout, while the Send panel is the active (visible) one.
requestAnimationFrame(() => {
  const h = els.sendPanel.offsetHeight;
  if (h) els.downloadPanel.style.minHeight = h + "px";
});

// --- File selection ---
els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", (e) => pickFile(e.target.files[0]));
els.drop.addEventListener("dragover", (e) => { e.preventDefault(); els.drop.classList.add("drag"); });
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("drag"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault(); els.drop.classList.remove("drag");
  pickFile(e.dataTransfer.files[0]);
});
els.token.addEventListener("input", refreshSendState);
els.channel.addEventListener("input", refreshSendState);

// Auto-grow the message box: one line by default, expand with content up to a cap.
const NOTE_MAX = 120;
function autoGrowNote() {
  els.note.style.height = "auto";
  const h = Math.min(els.note.scrollHeight, NOTE_MAX);
  els.note.style.height = h + "px";
  els.note.style.overflowY = els.note.scrollHeight > NOTE_MAX ? "auto" : "hidden";
}
els.note.addEventListener("input", autoGrowNote);
autoGrowNote(); // set the initial single-line height
els.chunk.addEventListener("input", updateChunkInfo);
els.maxmsg.addEventListener("input", updateChunkInfo);

// --- Detect token + channel from the active Discord tab ---
function grabFromPage() {
  let token = null;
  try {
    const f = document.createElement("iframe");
    f.style.display = "none";
    document.body.appendChild(f);
    const ls = f.contentWindow.localStorage;
    if (ls && ls.token) token = JSON.parse(ls.token);
    f.remove();
  } catch (_) {}
  if (!token) {
    try { if (window.localStorage && window.localStorage.token) token = JSON.parse(window.localStorage.token); } catch (_) {}
  }
  let channelId = null;
  const m = location.href.match(/channels\/(?:@me|\d+)\/(\d+)/);
  if (m) channelId = m[1];
  return { token, channelId };
}
// `auto` = ran on popup open: stay silent and keep existing values off Discord.
async function detectFromTab(auto = false) {
  if (!auto) setStatus("Reading from Discord tab…", "info");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isDiscord = tab && /^https:\/\/(discord\.com|discordapp\.com)\//.test(tab.url || "");
    if (!isDiscord) {
      if (!auto) setStatus("Open a Discord tab (discord.com) first, then Detect.", "err");
      return; // not a Discord tab — leave the previous token/channel untouched
    }
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabFromPage });
    if (result?.token) { els.token.value = result.token; chrome.storage.local.set({ token: result.token }); }
    if (result?.channelId) { els.channel.value = result.channelId; chrome.storage.local.set({ channel: result.channelId }); }
    refreshSendState();
    if (result?.token && result?.channelId) setStatus("Got token + channel ✓", "ok");
    else if (result?.token) setStatus(auto ? "Token detected." : "Got token. Open the target DM/channel for its ID.", "info");
    else if (!auto) setStatus("Couldn't read token — paste from DevTools → Application → Local Storage.", "err");
  } catch (err) {
    if (!auto) setStatus("Detect failed: " + err.message, "err");
  }
}
els.detect.addEventListener("click", () => detectFromTab(false));

// ============================ SEND ============================

// POST one message carrying one or more attachments (blobs[]/names[]).
// XHR (not fetch) so we get real upload-progress; rejections carry .status/.retryAfter.
function uploadBundle(token, channelId, blobs, names, note, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: note || "" }));
    blobs.forEach((blob, i) => form.append(`files[${i}]`, blob, names[i]));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/channels/${channelId}/messages`);
    xhr.setRequestHeader("Authorization", token);
    xhr.upload.addEventListener("progress", (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded); });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch (_) {}
      const err = new Error(`HTTP ${xhr.status}${body.message ? " — " + body.message : ""}`);
      err.status = xhr.status;
      if (xhr.status === 429) {
        err.retryAfter = body.retry_after != null ? Number(body.retry_after)
          : Number(xhr.getResponseHeader("retry-after")) || 1;
      }
      reject(err);
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.send(form);
  });
}
async function sendWithRetry(token, channelId, blobs, names, note, onProgress) {
  for (;;) {
    try { return await uploadBundle(token, channelId, blobs, names, note, onProgress); }
    catch (e) {
      if (e.status === 429 && e.retryAfter != null) {
        setStatus(`Rate limited — waiting ${e.retryAfter.toFixed(1)}s…`, "info");
        await sleep((e.retryAfter + 0.5) * 1000);
        continue;
      }
      throw e;
    }
  }
}

els.send.addEventListener("click", async () => {
  const token = els.token.value.trim();
  const channelId = els.channel.value.trim();
  const note = els.note.value.trim();
  if (!selectedFile || !token || !channelId) return;

  const file = selectedFile;
  const { chunkBytes, total, perMsg } = chunkPlan(file.size);

  // Build the per-message plan (each message = up to `perMsg` chunks).
  const plan = [];
  if (total === 1) {
    plan.push({ blobs: [file], names: [file.name] });     // small file: original name, no suffix
  } else {
    let gi = 0;
    while (gi < total) {
      const blobs = [], names = [];
      for (let k = 0; k < perMsg && gi < total; k++, gi++) {
        const start = gi * chunkBytes;
        const end = Math.min(file.size, start + chunkBytes);
        blobs.push(file.slice(start, end));
        names.push(`${file.name}.${gi + 1}_${total}`);
      }
      plan.push({ blobs, names });
    }
  }

  els.send.disabled = true;
  els.progress.style.display = "block";
  els.bar.style.width = "0%";

  try {
    let sent = 0;
    for (let m = 0; m < plan.length; m++) {
      const { blobs, names } = plan[m];
      const bundleBytes = blobs.reduce((a, b) => a + b.size, 0);
      const partNote = m === 0 && note ? note : "";
      await sendWithRetry(token, channelId, blobs, names, partNote, (loaded) => {
        const overall = sent + loaded;
        els.bar.style.width = Math.round((overall / file.size) * 100) + "%";
        const where = plan.length === 1 ? "Uploading" : `Message ${m + 1}/${plan.length}`;
        setStatus(`${where} — ${humanSize(overall)} / ${humanSize(file.size)}`, "info");
      });
      sent += bundleBytes;
    }
    els.bar.style.width = "100%";
    setStatus(
      total === 1
        ? `Sent "${file.name}" (${humanSize(file.size)}) ✓`
        : `Sent "${file.name}" — ${total} chunks in ${plan.length} message(s) ✓`,
      "ok"
    );
    sfx.send();
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    els.send.disabled = false;
    setTimeout(() => { els.progress.style.display = "none"; }, 1200);
  }
});

// ========================== DOWNLOAD ==========================

// Match a chunk name "<base>.<index>_<total>".
const CHUNK_RE = /^(.*)\.(\d+)_(\d+)$/;

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

const PAGE = 100; // Discord's max messages per request

// Accumulated across pages so chunk sets that straddle a page boundary reunite,
// and "Load older" can append without losing what's already listed.
let groupsMap = new Map(); // key -> { name, total, parts:Map<idx,{url,size}>, order }
let groupOrder = 0;
let oldestId = null;       // id of the oldest message seen, for ?before=
let moreAvailable = false; // last page was full, so older history may exist

function resetGroups() {
  groupsMap = new Map();
  groupOrder = 0;
  oldestId = null;
  moreAvailable = false;
}

// Fetch one page of messages (optionally older than `before`).
async function fetchPage(token, channelId, before) {
  const qs = before ? `&before=${before}` : "";
  const res = await fetch(`${API}/channels/${channelId}/messages?limit=${PAGE}${qs}`, {
    headers: { Authorization: token },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b.message) msg += ` — ${b.message}`; } catch (_) {}
    throw new Error(msg);
  }
  return res.json(); // newest first
}

// Merge a page's attachments into groupsMap and update pagination state.
function ingest(messages) {
  for (const msg of messages) {
    for (const att of msg.attachments || []) {
      const m = att.filename.match(CHUNK_RE);
      if (m) {
        const base = m[1], idx = parseInt(m[2], 10), tot = parseInt(m[3], 10);
        const key = `${base}\u0000${tot}`;
        if (!groupsMap.has(key)) groupsMap.set(key, { name: base, total: tot, parts: new Map(), order: groupOrder++ });
        const g = groupsMap.get(key);
        if (!g.parts.has(idx)) g.parts.set(idx, { url: att.url, size: att.size });
      } else {
        // A plain (non-chunked) attachment — one-part file.
        groupsMap.set(`single\u0000${att.id}`, {
          name: att.filename, total: 1,
          parts: new Map([[1, { url: att.url, size: att.size }]]),
          order: groupOrder++, single: true,
        });
      }
    }
  }
  if (messages.length) oldestId = messages[messages.length - 1].id;
  moreAvailable = messages.length === PAGE;
}

// Fetch every part in order, concatenate, and save under the original name.
async function reassemble(group) {
  const parts = [];
  for (let i = 1; i <= group.total; i++) {
    const p = group.parts.get(i);
    if (!p) throw new Error(`Missing chunk ${i}/${group.total}`);
    setStatus(`Downloading "${group.name}" — part ${i}/${group.total}…`, "info");
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`Part ${i}: HTTP ${res.status}`);
    parts.push(await res.blob());
  }
  const blob = new Blob(parts, { type: inferMime(group.name) });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: group.name, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setStatus(`Saved "${group.name}" (${humanSize(blob.size)}) ✓`, "ok");
  sfx.download();
}

const VISIBLE_ROWS = 4; // show this many files before the list scrolls

// Cap the list to VISIBLE_ROWS items so it cuts cleanly (measured, so it holds
// even when a long filename wraps to two lines).
function limitListHeight() {
  const items = els.fileList.querySelectorAll(".item");
  if (items.length <= VISIBLE_ROWS) { els.fileList.style.maxHeight = ""; return; }
  const gap = 8;
  let h = 0;
  for (let i = 0; i < VISIBLE_ROWS; i++) h += items[i].offsetHeight;
  els.fileList.style.maxHeight = (h + gap * (VISIBLE_ROWS - 1)) + "px";
}

function renderList() {
  els.fileList.textContent = "";
  els.loadOlderWrap.textContent = "";
  const groups = [...groupsMap.values()].sort((a, b) => a.order - b.order);
  if (moreAvailable) els.loadOlderWrap.appendChild(makeLoadOlderButton());
  if (!groups.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = moreAvailable
      ? "No files in these messages — try Load older."
      : "No files found.";
    els.fileList.appendChild(e);
    return;
  }
  for (const g of groups) {
    const have = g.parts.size;
    const complete = have === g.total;
    const knownBytes = [...g.parts.values()].reduce((a, p) => a + (p.size || 0), 0);

    const item = document.createElement("div");
    item.className = "item";

    const meta = document.createElement("div");
    meta.className = "meta";
    const fname = document.createElement("div");
    fname.className = "fname";
    fname.textContent = g.name;
    const sub = document.createElement("div");
    sub.className = "sub" + (complete ? "" : " incomplete");
    sub.textContent = g.single
      ? humanSize(knownBytes)
      : complete
        ? `${g.total} chunks · ${humanSize(knownBytes)}`
        : `incomplete — ${have}/${g.total} chunks found`;
    meta.appendChild(fname);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.textContent = "Download";
    btn.disabled = !complete;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try { await reassemble(g); }
      catch (err) { setStatus(err.message, "err"); }
      finally { btn.disabled = false; }
    });

    item.appendChild(meta);
    item.appendChild(btn);
    els.fileList.appendChild(item);
  }
  limitListHeight();
}

function makeLoadOlderButton() {
  const btn = document.createElement("button");
  btn.className = "mini";
  btn.id = "loadOlder";
  btn.style.width = "100%";
  btn.textContent = "Load older files";
  btn.addEventListener("click", () => loadOlder());
  return btn;
}

let listLoading = false;
// `auto` = triggered by switching tabs (stay quiet if creds aren't set yet).
async function refreshList(auto = false) {
  const token = els.token.value.trim();
  const channelId = els.channel.value.trim();
  if (!token || !channelId) {
    if (!auto) setStatus("Need token + channel first (use Detect).", "err");
    return;
  }
  if (listLoading) return;
  listLoading = true;
  setStatus("Loading recent files…", "info");
  try {
    resetGroups();
    ingest(await fetchPage(token, channelId, null));
    renderList();
    setStatus(`Found ${groupsMap.size} file(s).`, "ok");
  } catch (err) {
    setStatus("Failed to load: " + err.message, "err");
  } finally {
    listLoading = false;
  }
}

// Append the next older page to the list.
async function loadOlder() {
  const token = els.token.value.trim();
  const channelId = els.channel.value.trim();
  if (!token || !channelId || listLoading || !oldestId) return;
  listLoading = true;
  const btn = document.getElementById("loadOlder");
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  setStatus("Loading older files…", "info");
  try {
    ingest(await fetchPage(token, channelId, oldestId));
    renderList();
    setStatus(`${groupsMap.size} file(s) loaded${moreAvailable ? " (more available)" : ""}.`, "ok");
  } catch (err) {
    setStatus("Failed to load older: " + err.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = "Load older files"; }
  } finally {
    listLoading = false;
  }
}

