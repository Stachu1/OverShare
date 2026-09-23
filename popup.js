"use strict";

const MAX_ATTACHMENTS = 10; // Discord's hard cap per message

const els = {
  token: document.getElementById("token"),
  tokenStatus: document.getElementById("tokenStatus"),
  channel: document.getElementById("channel"),
  channelName: document.getElementById("channelName"),
  knownChannels: document.getElementById("knownChannels"),
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
  folder: document.getElementById("folder"),
  folderBtn: document.getElementById("folderBtn"),
  drop: document.getElementById("drop"),
  dropLabel: document.getElementById("dropLabel"),
  note: document.getElementById("note"),
  send: document.getElementById("send"),
  progress: document.getElementById("progress"),
  bar: document.getElementById("bar"),
  // download
  dlProgress: document.getElementById("dlProgress"),
  dlBar: document.getElementById("dlBar"),
  fileList: document.getElementById("fileList"),
  loadOlderWrap: document.getElementById("loadOlderWrap"),
  // shared
  status: document.getElementById("status"),
  version: document.getElementById("version"),
  mute: document.getElementById("mute"),
};

let muted = false;
let knownChannels = []; // [{ id, name }] of channels that resolved successfully

// Show the extension version (from the manifest) in the header.
els.version.textContent = "v" + chrome.runtime.getManifest().version;

// Current selection (raw) and the compressed payload we actually send.
let selection = null; // { kind:"file"|"folder", name, files:[{file, path}] }
let payload = null;   // { kind, name, base, bytes:Uint8Array, sha256, originalSize, zippedSize, entries }
let zipping = false;

// --- Restore/persist settings ---
chrome.storage.local.get(["token", "channel", "chunkMB", "filesPerMsg", "muted", "channelName", "knownChannels"], (data) => {
  if (data.token) els.token.value = data.token;
  if (data.channel) els.channel.value = data.channel;
  if (data.chunkMB) els.chunk.value = data.chunkMB;
  if (data.filesPerMsg) els.maxmsg.value = data.filesPerMsg;
  if (data.channelName) setChannelName(data.channelName); // instant, refreshed below
  knownChannels = Array.isArray(data.knownChannels) ? data.knownChannels : [];
  populateKnownSelect();
  muted = !!data.muted;
  updateMuteIcon();
  refreshSendState();
  updateChunkInfo();
  // Restore is done — if the popup opened on a Discord tab, auto-fill from it;
  // otherwise keep the values just restored.
  detectFromTab(true);
  resolveChannelName(); // refresh the name from the stored token/channel
  validateToken();      // check the stored token and set the button state
});
els.token.addEventListener("change", () => {
  chrome.storage.local.set({ token: els.token.value.trim() });
  validateToken();
});
els.channel.addEventListener("change", () => {
  chrome.storage.local.set({ channel: els.channel.value.trim() });
  resolveChannelName();
  validateToken();
});
els.chunk.addEventListener("change", () => chrome.storage.local.set({ chunkMB: els.chunk.value.trim() }));
els.maxmsg.addEventListener("change", () => chrome.storage.local.set({ filesPerMsg: els.maxmsg.value.trim() }));

// --- Helpers ---
function setStatus(msg, kind = "info") {
  els.status.textContent = msg;
  els.status.className = `status ${kind}`;
}

// --- Token validity indicator ---
function setTokenStatus(state) {
  const el = els.tokenStatus;
  if (state === true) { el.className = "tokenstatus ok"; el.textContent = "Token valid"; }
  else if (state === false) { el.className = "tokenstatus bad"; el.textContent = "No valid token — open Discord and reopen this popup, or paste a token"; }
  else { el.className = "tokenstatus checking"; el.textContent = "Checking token…"; }
}
async function validateToken() {
  const token = els.token.value.trim();
  if (!token) { setTokenStatus(false); return; }
  setTokenStatus(null); // checking…
  const channelId = els.channel.value.trim();
  // A real read: 5 messages from the channel, else /users/@me if no channel yet.
  const url = channelId ? `${API}/channels/${channelId}/messages?limit=5` : `${API}/users/@me`;
  try {
    const res = await fetch(url, { headers: { Authorization: token } });
    setTokenStatus(res.ok);
  } catch (_) {
    setTokenStatus(false);
  }
}

// --- Channel / DM name resolution + saved list ---
function setChannelName(name) {
  els.channelName.textContent = name ? " · " + name : "";
}
function populateKnownSelect() {
  const sel = els.knownChannels;
  sel.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = knownChannels.length ? "Saved ▾" : "None saved";
  ph.disabled = true; ph.selected = true;
  sel.appendChild(ph);
  for (const c of knownChannels) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name || c.id;
    sel.appendChild(o);
  }
}
function upsertKnown(id, name) {
  if (!id) return;
  const existing = knownChannels.find((c) => c.id === id);
  if (existing) { if (name) existing.name = name; }
  else knownChannels.push({ id, name: name || "" });
  chrome.storage.local.set({ knownChannels });
  populateKnownSelect();
}
els.knownChannels.addEventListener("change", () => {
  const id = els.knownChannels.value;
  els.knownChannels.selectedIndex = 0; // snap back to the "Saved ▾" placeholder
  if (!id) return;
  els.channel.value = id;
  chrome.storage.local.set({ channel: id });
  resolveChannelName();
  refreshSendState();
});
async function resolveChannelName() {
  const token = els.token.value.trim();
  const channelId = els.channel.value.trim();
  if (!token || !channelId) { setChannelName(""); chrome.storage.local.set({ channelName: "" }); return; }
  try {
    const res = await fetch(`${API}/channels/${channelId}`, { headers: { Authorization: token } });
    if (!res.ok) return; // leave the current (possibly stored) name on failure
    const ch = await res.json();
    let name = "";
    if (ch.name) name = "#" + ch.name;                    // guild / named group channel
    else if (Array.isArray(ch.recipients) && ch.recipients.length) {
      name = "@" + ch.recipients.map((r) => r.global_name || r.username).join(", "); // DM
    } else name = "DM";
    setChannelName(name);
    chrome.storage.local.set({ channelName: name });
    upsertKnown(channelId, name); // remember this channel for the dropdown
  } catch (_) { /* keep current text */ }
}

// --- Sound effects (synthesized, no asset files) ---
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function updateMuteIcon() {
  els.mute.textContent = muted ? "🔇" : "🔊";
  els.mute.title = muted ? "Unmute sounds" : "Mute sounds";
}
els.mute.addEventListener("click", () => {
  muted = !muted;
  chrome.storage.local.set({ muted });
  updateMuteIcon();
  sfx.clickForced(); // the toggle always clicks, even when muting
});

function tone(freq, dur, { type = "sine", gain = 0.05, delay = 0 } = {}) {
  if (muted) return;
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
function noiseBurst(dur, { gain = 0.08, hp = 1800, lp = 8000, force = false } = {}) {
  if (muted && !force) return;
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
  clickForced: () => noiseBurst(0.022, { gain: 0.12, hp: 2200, lp: 9000, force: true }), // ignores mute
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
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && b !== els.mute) sfx.click(); // mute plays its own forced click
}, true);

// Split math + message packing, shared by the readout and the sender.
function chunkPlan(fileSize) {
  const chunkMB = parseFloat(els.chunk.value) || 20;
  const filesPerMsg = parseInt(els.maxmsg.value, 10) || MAX_ATTACHMENTS;
  const chunkBytes = Math.max(1, Math.floor(chunkMB * 1024 * 1024));
  const total = Math.max(1, Math.ceil(fileSize / chunkBytes));
  const perMsg = Math.max(1, Math.min(MAX_ATTACHMENTS, filesPerMsg));
  const messages = Math.ceil(total / perMsg);
  return { chunkBytes, total, perMsg, messages };
}
// Always shown: chunks per message × number of messages ("x" until a file is picked).
function updateChunkInfo() {
  if (!payload) { els.chunkInfo.textContent = "_ chunks | _ messages"; return; }
  const { total, perMsg, messages } = chunkPlan(payload.zippedSize);
  const per = Math.min(perMsg, total);
  els.chunkInfo.textContent =
    `${per} chunk${per === 1 ? "" : "s"} | ${messages} message${messages === 1 ? "" : "s"}`;
}
function refreshSendState() {
  if (isSending()) return; // the button is "Cancel" while a send runs
  els.send.disabled = !(payload && !zipping && els.token.value.trim() && els.channel.value.trim());
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

// --- File / folder selection + compression ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }
// Fixed zip timestamp → deterministic archives. ZIP's DOS date only allows
// 1980–2107, so epoch 0 (1970) throws "date not in range"; use a fixed 1985 date.
const ZIP_MTIME = new Date(Date.UTC(1985, 0, 1));
// Recursively read a dropped directory entry into {file, path} records.
function readEntry(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => resolve([{ file: f, path: prefix + entry.name }]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const acc = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          const nested = await Promise.all(acc.map((e) => readEntry(e, prefix + entry.name + "/")));
          resolve(nested.flat());
        } else { acc.push(...batch); readBatch(); }
      }, () => resolve([]));
      readBatch();
    } else resolve([]);
  });
}

function setFileSelection(file) {
  if (!file) return;
  selection = { kind: "file", name: file.name, files: [{ file, path: file.name }] };
  prepareSelection();
}
function setFolderSelection(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const top = (files[0].webkitRelativePath || files[0].name).split("/")[0];
  selection = {
    kind: "folder", name: top || "folder",
    files: files.map((f) => ({ file: f, path: f.webkitRelativePath || f.name })),
  };
  prepareSelection();
}
function setDropSelection(records) {
  if (!records.length) return;
  if (records.length === 1 && !records[0].path.includes("/")) { setFileSelection(records[0].file); return; }
  const top = records[0].path.split("/")[0];
  selection = { kind: "folder", name: top || "overshare-bundle", files: records };
  prepareSelection();
}

// Zip + hash the selection so we know the size and can send instantly.
async function prepareSelection() {
  if (!selection) return;
  payload = null;
  zipping = true;
  refreshSendState();
  els.drop.classList.add("has-file");
  const fileCount = selection.files.length;
  const originalSize = selection.files.reduce((a, r) => a + r.file.size, 0);
  const label = escapeHtml(selection.name) + (selection.kind === "folder" ? "/" : "");
  els.dropLabel.innerHTML = `<div class="name">${label}</div><div class="size">Compressing ${fileCount} file${fileCount > 1 ? "s" : ""}…</div>`;
  setStatus("Compressing…", "info");
  try {
    const input = {};
    for (const r of selection.files) input[r.path] = [await readBytes(r.file), { level: 6, mtime: ZIP_MTIME }];
    const bytes = fflate.zipSync(input);
    const sha256 = await sha256hex(bytes);
    payload = {
      kind: selection.kind, name: selection.name, base: selection.name + ".zip",
      bytes, sha256, originalSize, zippedSize: bytes.length, entries: fileCount,
    };
    els.dropLabel.innerHTML =
      `<div class="name">${label}</div>` +
      `<div class="size">${humanSize(originalSize)} → ${humanSize(bytes.length)} zipped` +
      `${selection.kind === "folder" ? ` · ${fileCount} files` : ""}</div>`;
    setStatus(`Ready: ${humanSize(originalSize)} → ${humanSize(bytes.length)} zipped.`, "ok");
  } catch (err) {
    payload = null;
    setStatus("Compression failed: " + err.message, "err");
    els.dropLabel.textContent = "Click for a file, or drop a file / folder";
    els.drop.classList.remove("has-file");
  } finally {
    zipping = false;
    refreshSendState();
    updateChunkInfo();
  }
}

els.drop.addEventListener("click", () => { if (!isSending()) els.file.click(); });
els.file.addEventListener("change", (e) => setFileSelection(e.target.files[0]));
els.folderBtn.addEventListener("click", () => { if (!isSending()) els.folder.click(); });
els.folder.addEventListener("change", (e) => setFolderSelection(e.target.files));
els.drop.addEventListener("dragover", (e) => { e.preventDefault(); if (!isSending()) els.drop.classList.add("drag"); });
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("drag"));
els.drop.addEventListener("drop", async (e) => {
  e.preventDefault(); els.drop.classList.remove("drag");
  if (isSending()) return;
  const items = e.dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    const entries = [...items].map((it) => it.webkitGetAsEntry()).filter(Boolean);
    const records = (await Promise.all(entries.map((en) => readEntry(en, "")))).flat();
    setDropSelection(records);
  } else {
    const files = [...e.dataTransfer.files];
    if (files.length === 1) setFileSelection(files[0]);
    else setDropSelection(files.map((f) => ({ file: f, path: f.name })));
  }
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
    resolveChannelName();
    validateToken();
    if (result?.token && result?.channelId) setStatus("Got token + channel ✓", "ok");
    else if (result?.token) setStatus(auto ? "Token detected." : "Got token. Open the target DM/channel for its ID.", "info");
    else if (!auto) setStatus("Couldn't read token — paste from DevTools → Application → Local Storage.", "err");
  } catch (err) {
    if (!auto) setStatus("Detect failed: " + err.message, "err");
  }
}

// ============================ ENGINE ============================
// Sends and downloads run in engine.js (an offscreen document kept alive by
// background.js), so they continue after this popup closes. We hand it jobs and
// render the state it pushes back.

const engine = new BroadcastChannel(ENGINE_CHANNEL);
let engineState = { send: null, download: null, status: null };
let lastStatusSeq = 0;
let progressHideTimer = null;

function isSending() { return !!(engineState.send && engineState.send.active); }
function isDownloading() { return !!(engineState.download && engineState.download.active); }

// Lock everything that could start a second send or change the running one.
function setSendLock(locked) {
  for (const el of [els.token, els.channel, els.knownChannels, els.folderBtn, els.chunk, els.maxmsg, els.note]) {
    el.disabled = locked;
  }
  els.drop.classList.toggle("locked", locked);
  els.send.classList.toggle("cancel", locked);
  if (locked) {
    els.send.textContent = "Cancel";
    els.send.disabled = false;
  } else {
    els.send.textContent = "Send file";
    refreshSendState();
  }
}

function applyEngineState(s) {
  const prev = engineState;
  engineState = s;
  const sending = isSending();

  // --- Send ---
  setSendLock(sending);
  if (sending) {
    clearTimeout(progressHideTimer);
    els.progress.style.display = "block";
    els.bar.style.width = s.send.percent + "%";
    if (!payload) { // popup reopened mid-send: show what's going out
      els.drop.classList.add("has-file");
      els.dropLabel.innerHTML = `<div class="name">${escapeHtml(s.send.name)}</div><div class="size">Sending…</div>`;
    }
  } else if (prev.send && prev.send.active) {
    if (s.send.outcome === "ok") els.bar.style.width = "100%";
    progressHideTimer = setTimeout(() => { els.progress.style.display = "none"; }, 1200);
    if (!payload) {
      els.dropLabel.textContent = "Click for a file, or drop a file / folder";
      els.drop.classList.remove("has-file");
    }
    if (s.send.outcome === "ok") sfx.send();
  }

  // --- Download ---
  const downloading = isDownloading();
  els.dlProgress.style.display = downloading ? "block" : "none";
  if (downloading) els.dlBar.style.width = s.download.percent + "%";
  for (const btn of els.fileList.querySelectorAll("button[data-id]")) {
    const mine = downloading && btn.dataset.id === s.download.id;
    btn.disabled = downloading || btn.dataset.complete !== "1";
    btn.textContent = mine ? s.download.percent + "%" : "Download";
  }
  if (!downloading && prev.download && prev.download.active && s.download.outcome === "ok") sfx.download();

  // --- Status line ---
  if (s.status && s.status.seq !== lastStatusSeq) {
    lastStatusSeq = s.status.seq;
    setStatus(s.status.msg, s.status.kind);
  }
}

engine.onmessage = (e) => {
  if (e.data && e.data.type === "state") applyEngineState(e.data.state);
};
// Make sure the engine exists, then ask it for the current state.
(async () => {
  try { await chrome.runtime.sendMessage({ target: "background", type: "ensureEngine" }); } catch (_) {}
  engine.postMessage({ type: "hello" });
})();

els.send.addEventListener("click", () => {
  if (isSending()) {
    engine.postMessage({ type: "cancelSend" });
    els.send.disabled = true; // until the engine confirms
    setStatus("Canceling…", "info");
    return;
  }
  const token = els.token.value.trim();
  const channelId = els.channel.value.trim();
  if (!payload || zipping || !token || !channelId) return;
  const { chunkBytes, perMsg } = chunkPlan(payload.zippedSize);
  engine.postMessage({
    type: "send",
    job: {
      token, channelId, note: els.note.value.trim(),
      blob: new Blob([payload.bytes]), chunkBytes, perMsg,
      meta: {
        kind: payload.kind, name: payload.name, base: payload.base,
        originalSize: payload.originalSize, zippedSize: payload.zippedSize,
        sha256: payload.sha256, entries: payload.entries,
      },
    },
  });
  // Lock right away so a quick second click can't queue another send.
  applyEngineState({ ...engineState, send: { active: true, name: payload.name, percent: 0, outcome: null } });
});

// ========================== DOWNLOAD ==========================

// Match a chunk name "<base>.<index>_<total>".
const CHUNK_RE = /^(.*)\.(\d+)_(\d+)$/;

const PAGE = 20; // read in batches of 20, paging with ?before=<oldest id>

// Accumulated across pages so chunk sets that straddle a page boundary reunite,
// and "Load older" can append without losing what's already listed.
let messagesById = new Map(); // id -> raw message, accumulated across pages
let oldestId = null;          // id of the oldest message seen, for ?before=
let moreAvailable = false;    // last page was full, so older history may exist
let lastGroups = [];          // most recent rebuildGroups() result

function resetGroups() {
  messagesById = new Map();
  oldestId = null;
  moreAvailable = false;
  lastGroups = [];
}

// Nice name for a group (all groups have a manifest now).
function displayName(g) {
  return g.manifest.name + (g.manifest.kind === "folder" ? "/" : "");
}

// Sort snowflake ids chronologically (ascending): older ids are shorter/smaller.
function byIdAsc(a, b) {
  const x = a.id, y = b.id;
  return x.length !== y.length ? x.length - y.length : (x < y ? -1 : x > y ? 1 : 0);
}

// Build the download list from accumulated messages. ONLY transfers sent by this
// tool are listed: a manifest starts a transfer, and chunks that follow it
// (matching base+total, until the next manifest for that base+total) join it —
// so re-sends of the same name don't merge, and random attachments are ignored.
function rebuildGroups() {
  const msgs = [...messagesById.values()].sort(byIdAsc);
  const groups = [];
  const active = new Map(); // base\0total -> current group
  let order = 0;
  for (const msg of msgs) {
    if (msg.content && msg.content.includes(MANIFEST_MARKER)) {
      try {
        // JSON sits on its own line after the marker (may be followed by "```||").
        const after = msg.content.slice(msg.content.lastIndexOf(MANIFEST_MARKER) + MANIFEST_MARKER.length);
        const json = after.split("\n")[0].trim();
        const mani = JSON.parse(json);
        if (mani && mani.base && mani.total) {
          const g = { id: msg.id, manifest: mani, name: mani.base, total: mani.total, parts: new Map(), order: order++ };
          groups.push(g);
          active.set(`${mani.base}\u0000${mani.total}`, g);
        }
      } catch (_) { /* not a valid manifest */ }
    }
    for (const att of msg.attachments || []) {
      const m = att.filename.match(CHUNK_RE);
      if (!m) continue;
      const idx = parseInt(m[2], 10), tot = parseInt(m[3], 10);
      const g = active.get(`${m[1]}\u0000${tot}`);
      if (g && !g.parts.has(idx)) g.parts.set(idx, { url: att.url, size: att.size });
    }
  }
  groups.sort((a, b) => b.order - a.order); // newest transfer first
  return groups;
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

// Accumulate a page of messages and update pagination state.
function addMessages(messages) {
  for (const msg of messages) messagesById.set(msg.id, msg);
  if (messages.length) oldestId = messages[messages.length - 1].id;
  moreAvailable = messages.length === PAGE;
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
  const groups = rebuildGroups();
  lastGroups = groups;
  if (moreAvailable) els.loadOlderWrap.appendChild(makeLoadOlderButton());
  if (!groups.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = moreAvailable
      ? "No OverShare files here — try Load older."
      : "No OverShare files found.";
    els.fileList.appendChild(e);
    return;
  }
  for (const g of groups) {
    const have = g.parts.size;
    const complete = have === g.total;

    const item = document.createElement("div");
    item.className = "item";

    const meta = document.createElement("div");
    meta.className = "meta";
    const fname = document.createElement("div");
    fname.className = "fname";
    fname.textContent = displayName(g);
    const sub = document.createElement("div");
    sub.className = "sub" + (complete ? "" : " incomplete");
    if (!complete) {
      sub.textContent = `incomplete — ${have}/${g.total} chunks found`;
    } else {
      const m = g.manifest;
      const kind = m.kind === "folder" ? `folder · ${m.entries} files` : "file";
      sub.textContent = `${humanSize(m.originalSize)} (${kind}) · 🔒 SHA-256`;
    }
    meta.appendChild(fname);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.textContent = "Download";
    btn.dataset.id = g.id;
    btn.dataset.complete = complete ? "1" : "";
    btn.disabled = !complete || isDownloading();
    btn.addEventListener("click", async () => {
      if (isDownloading()) return;
      // A folder asks for its destination here, while we still have the click's
      // user activation; the engine then writes into it.
      let dirHandle = null;
      if (g.manifest && g.manifest.kind === "folder" && window.showDirectoryPicker) {
        try { dirHandle = await window.showDirectoryPicker({ mode: "readwrite" }); }
        catch (err) {
          if (err && err.name === "AbortError") setStatus("Canceled.", "info");
          else setStatus(err.message || String(err), "err");
          return;
        }
      }
      const parts = [];
      for (let i = 1; i <= g.total; i++) parts.push(g.parts.get(i));
      engine.postMessage({
        type: "download",
        job: { id: g.id, name: displayName(g), manifest: g.manifest, parts, dirHandle },
      });
      applyEngineState({ ...engineState, download: { active: true, id: g.id, name: displayName(g), percent: 0, outcome: null } });
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
    addMessages(await fetchPage(token, channelId, null));
    renderList();
    setStatus(`Found ${lastGroups.length} file(s).`, "ok");
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
    addMessages(await fetchPage(token, channelId, oldestId));
    renderList();
    setStatus(`${lastGroups.length} file(s) loaded${moreAvailable ? " (more available)" : ""}.`, "ok");
  } catch (err) {
    setStatus("Failed to load older: " + err.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = "Load older files"; }
  } finally {
    listLoading = false;
  }
}

