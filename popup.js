"use strict";

const SETTINGS_KEYS = ["botToken", "channelId"];
const ids = ["file", "folder", "folderBtn", "drop", "dropLabel", "send", "progress", "bar", "status", "version", "keyCopy", "downloadToken", "loadToken", "deleteStorage", "botToken", "channelId", "botStatus", "botDot", "flyer", "tabs", "tabSend", "tabDownload", "sendPanel", "downloadPanel", "fileList", "downloadProgress", "downloadBar", "exportStorage", "importStorage", "importFile", "mute"];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let selection = null;
let payload = null;
let muted = false;
let activeUpload = null;
let activeDownload = null;
let lastSentToken = ""; // SHA.symmetricKey of the most recent completed send
let deletingShas = new Set();
const LIST_PAGE = 4; // files added to the Download list per load
let scanner = null, listRun = 0, listLoading = false, listFooter = null, shownFiles = 0, incompleteFiles = 0;
const itemControls = new Map(); // sha -> the rendered list row and its buttons
let config = { token: "", channelId: "" };
let botCheckRun = 0;
let botCheckTimer = 0;

els.version.textContent = "v" + chrome.runtime.getManifest().version;
// Restarts a one-shot CSS animation class, even if it is still running.
function replayAnimation(element, className) { element.classList.remove(className); void element.offsetWidth; element.classList.add(className); }
function setStatus(message, kind = "info") {
  els.status.textContent = message; els.status.className = `status ${kind}`;
  if (kind !== "info") replayAnimation(els.status, "pop");
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

async function readEntry(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) entry.file((file) => resolve([{ file, path: prefix + entry.name }]), () => resolve([]));
    else if (entry.isDirectory) {
      const reader = entry.createReader(), entries = [];
      const read = () => reader.readEntries(async (batch) => {
        if (!batch.length) resolve((await Promise.all(entries.map((e) => readEntry(e, prefix + entry.name + "/")))).flat());
        else { entries.push(...batch); read(); }
      }, () => resolve([]));
      read();
    } else resolve([]);
  });
}
function setFileSelection(file) { if (file) { selection = { kind: "file", name: file.name, files: [{ file, path: file.name }] }; prepareSelection(); } }
function setFolderSelection(fileList) {
  const files = [...fileList]; if (!files.length) return;
  const name = (files[0].webkitRelativePath || files[0].name).split("/")[0];
  selection = { kind: "folder", name, files: files.map((file) => ({ file, path: file.webkitRelativePath || file.name })) }; prepareSelection();
}
// Several loose files (or a mix of files and folders) are sent as one bundle named by its file count.
function setBundleSelection(records) { selection = { kind: "multiplefiles", name: `${records.length}_files`, files: records }; prepareSelection(); }
const showsSlash = (kind) => kind === "folder" || kind === "multiplefiles";
// Selecting only picks the transfer ID and key; the engine reads the files while sending.
function prepareSelection() {
  if (!selection) return;
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  payload = {
    kind: selection.kind, name: selection.name, files: selection.files,
    sha: hex(crypto.getRandomValues(new Uint8Array(ID_BYTES))), symmetricKey: base64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    originalSize: selection.files.reduce((n, r) => n + r.file.size, 0), entries: selection.files.length,
  };
  els.drop.classList.add("has-file");
  els.dropLabel.innerHTML = `<div class="name">${escapeHtml(selection.name)}${showsSlash(selection.kind) ? "/" : ""}</div><div class="size">${humanSize(payload.originalSize)} · ${payload.entries} file(s)</div>`;
  setStatus("Ready to send.", "ok");
  replayAnimation(els.drop, "pop");
  requestAnimationFrame(() => replayAnimation(els.send, "ready"));
  refreshSendState();
}
function clearSelection() {
  selection = null; payload = null;
  els.file.value = ""; els.folder.value = "";
  els.drop.classList.remove("has-file");
  els.dropLabel.textContent = "Click for a file, or drop a file / folder";
}
function refreshSendState() {
  if (activeUpload) {
    els.send.disabled = !!activeUpload.canceling;
    els.send.textContent = activeUpload.canceling ? "Canceling…" : "Cancel";
    els.send.classList.add("cancel");
    return;
  }
  els.send.classList.remove("cancel");
  els.send.textContent = "Send";
  els.send.disabled = !payload;
}
function resetUploadProgress() {
  els.progress.style.display = "none";
  els.bar.style.width = "0%";
}
function applyUploadState(state) {
  if (state.active) {
    activeUpload = { ...activeUpload, ...state };
    els.progress.style.display = "block";
    const percent = state.totalBytes
      ? Math.min(100, Math.round((state.bytesSent / state.totalBytes) * 100))
      : Math.min(100, Math.round(((state.sent || 0) / (state.total || 1)) * 100));
    els.bar.style.width = percent + "%";
    const chunk = `chunk ${state.sending || 1}`;
    if (state.cleaning) setStatus(`Removing sent chunks of ${state.name}…`, "info");
    else if (state.canceling) setStatus(`Canceling upload… ${percent}%`, "info");
    else setStatus(`Sending ${chunk} · ${percent}% · ${transferStats(state)}`, "info");
    refreshSendState();
  } else if (activeUpload || state.outcome === "interrupted") {
    // An idle reply can race a send this popup just started; only a restored upload should be cleared by it.
    if (state.idle && !activeUpload.restored) return;
    const old = activeUpload;
    activeUpload = null;
    resetUploadProgress();
    refreshSendState();
    if (state.idle) return;
    if (state.outcome === "ok") { if (old.symmetricKey) lastSentToken = `${old.sha}.${old.symmetricKey}`; playSound("send"); setStatus(`Sent ${state.name || old.name}: ${humanSize(state.size || 0)} (${humanSize(state.speed || 0)}/s) 🚀`, "ok"); launchFlyer("🚀", "fly"); }
    else setStatus(state.text || "Upload failed", state.failed ? "err" : "info");
  }
}

function launchFlyer(emoji, className) {
  els.flyer.textContent = emoji;
  els.flyer.className = "flyer";
  replayAnimation(els.flyer, className);
}

let audioContext = null;
function playTone(frequency, duration, delay = 0) {
  if (muted) return;
  try {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const start = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.04, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  } catch (_) {}
}
function playSound(name) {
  if (name === "hover") playTone(1200, 0.018);
  if (name === "click") playTone(720, 0.035);
  if (name === "send") { playTone(523, 0.1); playTone(659, 0.1, 0.09); playTone(784, 0.14, 0.18); }
  if (name === "download") { playTone(784, 0.1); playTone(523, 0.16, 0.1); }
}
let hoveredButton = null;
document.addEventListener("mouseover", (event) => { const button = event.target.closest("button"); if (button && button !== hoveredButton) { hoveredButton = button; playSound("hover"); } });
document.addEventListener("mouseout", (event) => { if (!event.relatedTarget?.closest?.("button")) hoveredButton = null; });
document.addEventListener("click", (event) => { const button = event.target.closest("button"); if (button && button !== els.mute) playSound("click"); }, true);

function setBotStatus(message, kind) {
  els.botStatus.textContent = message; els.botStatus.className = `tokenstatus ${kind}`;
  els.botDot.className = `dot ${kind}`;
}
async function checkBot() {
  const run = ++botCheckRun;
  if (!config.token || !config.channelId) { setBotStatus("Enter the bot token and channel ID", "bad"); return false; }
  setBotStatus("Checking bot…", "checking");
  try {
    const bot = await discordRequest(config, "GET", "/users/@me");
    const target = await discordRequest(config, "GET", `/channels/${config.channelId}`);
    if (run !== botCheckRun) return false;
    setBotStatus(`Connected as ${bot.username} · ${target.name ? "#" + target.name : "DM"}`, "ok");
    return true;
  } catch (error) { if (run === botCheckRun) setBotStatus(error.message, "bad"); return false; }
}
// Saves on every keystroke so a half-entered setting survives closing the popup;
// the Discord check waits until typing pauses.
function onBotInput() {
  config = { token: els.botToken.value.trim(), channelId: els.channelId.value.trim() };
  chrome.storage.local.set({ botToken: config.token, channelId: config.channelId });
  clearTimeout(botCheckTimer);
  botCheckRun++;
  setBotStatus("Checking bot…", "checking");
  botCheckTimer = setTimeout(async () => { if (await checkBot() && els.downloadPanel.classList.contains("active")) refreshFiles(); }, 700);
}
function requireConfig() { if (!config.token || !config.channelId) throw new Error("set the bot token and channel ID first"); }
function showTab(download) {
  els.tabs.classList.toggle("download", download);
  els.tabSend.classList.toggle("active", !download); els.tabDownload.classList.toggle("active", download);
  els.sendPanel.classList.toggle("active", !download); els.downloadPanel.classList.toggle("active", download);
  if (download) refreshFiles();
}
async function storedKeys() {
  const data = await chrome.storage.local.get(null);
  return Object.entries(data).filter(([name, value]) => name.endsWith(".symmetricKey") && typeof value === "string").map(([name, value]) => `${name.slice(0, -13)}.${value}`);
}
function updateItemButtons() {
  for (const [sha, { file, downloadButton, deleteButton }] of itemControls) {
    const downloading = activeDownload?.sha === sha, deleting = deletingShas.has(sha);
    downloadButton.disabled = !file.available || !!activeDownload || deleting;
    downloadButton.textContent = downloading ? "Downloading…" : "Download";
    deleteButton.disabled = deleting || downloading;
    deleteButton.textContent = deleting ? "Deleting…" : "Delete";
  }
  els.deleteStorage.disabled = deletingShas.size > 0;
}
function timeAgo(time) {
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return new Date(time).toLocaleDateString();
}
function fileRow(file, position) {
  const item = document.createElement("div"); item.className = "item"; item.style.setProperty("--i", position);
  const meta = document.createElement("div"); meta.className = "meta";
  const name = document.createElement("div"); name.className = "fname"; name.textContent = file.name + (showsSlash(file.kind) ? "/" : "");
  const sub = document.createElement("div"); sub.className = file.available ? "sub" : "sub incomplete";
  sub.textContent = file.available ? `${humanSize(file.originalSize)} · ${file.total} chunk(s)`
    : file.manifestFound ? `${humanSize(file.originalSize)} · missing ${file.missingChunks} chunk(s)`
    : file.orphanChunks ? `upload never finished · ${file.orphanChunks} chunk(s) left behind` : "missing from channel";
  meta.append(name, sub);
  if (file.sentAt) {
    const when = document.createElement("div"); when.className = "sub sent-at"; when.dataset.time = file.sentAt;
    when.textContent = timeAgo(file.sentAt); when.title = new Date(file.sentAt).toLocaleString();
    meta.append(when);
  }
  const actions = document.createElement("div"); actions.className = "item-actions";
  const button = document.createElement("button"); button.textContent = "Download"; button.addEventListener("click", () => downloadFile(file));
  const copyButton = document.createElement("button"); copyButton.className = "copy-token"; copyButton.textContent = "Copy"; copyButton.title = "Copy file token";
  copyButton.addEventListener("click", () => copyFileToken(file, copyButton));
  const deleteButton = document.createElement("button"); deleteButton.className = "delete-file"; deleteButton.textContent = "Delete"; deleteButton.title = "Delete this file from Discord and local storage";
  deleteButton.addEventListener("click", () => deleteFileToken(file));
  const secondaryActions = document.createElement("div"); secondaryActions.className = "secondary-actions";
  secondaryActions.append(copyButton, deleteButton);
  actions.append(button, secondaryActions); item.append(meta, actions);
  itemControls.set(file.sha, { file, item, downloadButton: button, deleteButton });
  return item;
}
async function copyFileToken(file, button) {
  try {
    const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
    const symmetricKey = keyData[`${file.sha}.symmetricKey`];
    if (!symmetricKey) throw new Error("token is not stored locally");
    await navigator.clipboard.writeText(`${file.sha}.${symmetricKey}`);
    setStatus("File token copied to clipboard.", "ok");
  } catch (error) { setStatus("Copy failed: " + error.message, "err"); }
}
async function deleteFileToken(file) {
  const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
  if (!keyData[`${file.sha}.symmetricKey`]) { setStatus("Delete failed: token is not stored locally.", "err"); return; }
  if (!confirm(`Delete "${file.name}" from Discord and local storage? This cannot be undone.`)) return;
  try { requireConfig(); } catch (error) { setStatus("Delete failed: " + error.message, "err"); return; }
  startDelete([file.sha], file.name);
}
// Deletes run in the engine, so they finish even if the popup closes.
function startDelete(shas, label) {
  deletingShas = new Set([...deletingShas, ...shas]);
  updateItemButtons();
  setStatus(`Deleting ${label}…`, "info");
  transferChannel.postMessage({ type: "startDelete", job: { config, shas, label } });
}
function applyDeleteState(state) {
  deletingShas = new Set(state.pendingShas || []);
  if (state.finished) {
    const { outcome, shas, text } = state.finished;
    setStatus(text, outcome === "ok" ? "ok" : "err");
    if (outcome === "ok" && els.downloadPanel.classList.contains("active")) {
      const rows = shas.map((sha) => itemControls.get(sha)?.item).filter(Boolean);
      rows.forEach((row) => row.classList.add("removing"));
      setTimeout(refreshFiles, rows.length ? 280 : 0);
    }
  } else if (state.current) setStatus(`Deleting ${state.current.label}… ${state.current.deleted} message(s) removed`, "info");
  updateItemButtons();
}
// The list starts with the newest few files and reads further back in the
// channel only when it is scrolled to the bottom.
async function refreshFiles() {
  const run = ++listRun;
  scanner = null; listLoading = false; shownFiles = 0; incompleteFiles = 0;
  itemControls.clear();
  if (!config.token || !config.channelId) { els.fileList.innerHTML = '<div class="empty">Set the bot token and channel ID first.</div>'; return; }
  els.fileList.textContent = "";
  listFooter = document.createElement("div"); listFooter.className = "empty";
  els.fileList.appendChild(listFooter);
  const keys = await storedKeys();
  if (run !== listRun) return;
  scanner = new TransferScanner(config, keys);
  loadMoreFiles();
}
async function loadMoreFiles() {
  if (!scanner || scanner.done || listLoading) return;
  const run = listRun;
  listLoading = true;
  listFooter.textContent = "Searching Discord…";
  try {
    const files = await scanner.next(LIST_PAGE);
    if (run !== listRun) return;
    files.forEach((file, position) => els.fileList.insertBefore(fileRow(file, position), listFooter));
    shownFiles += files.length;
    incompleteFiles += files.filter((file) => !file.available).length;
    updateItemButtons();
  } catch (error) {
    if (run !== listRun) return;
    scanner = null;
    listFooter.textContent = "Could not search for files.";
    setStatus("Search failed: " + error.message, "err");
    return;
  } finally { if (run === listRun) listLoading = false; }
  if (scanner.done) {
    if (shownFiles) listFooter.remove(); else listFooter.textContent = "No files found.";
    setStatus(`${shownFiles - incompleteFiles} complete, ${incompleteFiles} incomplete file(s).`, incompleteFiles ? "info" : "ok");
  } else {
    listFooter.textContent = "Scroll for more";
    setStatus(`Showing the latest ${shownFiles} file(s).`, "ok");
  }
  loadIfAtBottom(); // keeps going while the list is too short to scroll
}
function loadIfAtBottom() {
  const list = els.fileList;
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 40) loadMoreFiles();
}
// Downloads run in the engine, so they finish even if the popup closes. A folder
// is picked here first, because the folder picker needs a click in this page.
async function downloadFile(file) {
  try {
    requireConfig();
    let dirHandle = null;
    if (file.kind === "folder" && window.showDirectoryPicker) dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
    const key = `${file.sha}.${keyData[`${file.sha}.symmetricKey`]}`;
    activeDownload = { active: true, sha: file.sha, name: file.name, phase: "downloading", done: 0, totalBytes: 0 };
    applyDownloadState(activeDownload);
    transferChannel.postMessage({ type: "startDownload", job: { config, key, sha: file.sha, name: file.name, kind: file.kind, dirHandle } });
  } catch (error) { if (error.name !== "AbortError") setStatus("Download failed: " + error.message, "err"); }
}
function applyDownloadState(state) {
  if (state.active) {
    activeDownload = state;
    els.downloadProgress.style.display = "block";
    const percent = state.phase === "saving" ? 100 : state.totalBytes ? Math.min(100, Math.round((state.done / state.totalBytes) * 100)) : 0;
    els.downloadBar.style.width = percent + "%";
    if (state.phase === "saving") setStatus(`Decrypting and saving ${state.name}…`, "info");
    else setStatus(`Downloading ${state.name} · ${percent}% · ${transferStats(state)}`, "info");
  } else {
    if (activeDownload?.sha === state.sha) activeDownload = null;
    if (state.outcome === "ok") { els.downloadBar.style.width = "100%"; playSound("download"); setStatus(state.text, "ok"); launchFlyer("📦", "drop-in"); }
    else setStatus(state.text, "err");
    if (!activeDownload) setTimeout(() => { if (!activeDownload) els.downloadProgress.style.display = "none"; }, 1200);
  }
  updateItemButtons();
}

els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", (event) => { const files = [...event.target.files]; if (files.length === 1) setFileSelection(files[0]); else if (files.length) setBundleSelection(files.map((file) => ({ file, path: file.name }))); });
els.folderBtn.addEventListener("click", () => els.folder.click());
els.folder.addEventListener("change", (event) => setFolderSelection(event.target.files));
els.drop.addEventListener("dragover", (event) => { event.preventDefault(); els.drop.classList.add("drag"); });
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("drag"));
els.drop.addEventListener("drop", async (event) => {
  event.preventDefault(); els.drop.classList.remove("drag"); const items = [...event.dataTransfer.items];
  if (items[0]?.webkitGetAsEntry) {
    const entries = items.map((item) => item.webkitGetAsEntry()).filter(Boolean);
    const records = (await Promise.all(entries.map((entry) => readEntry(entry, "")))).flat();
    if (!records.length) return;
    if (entries.length > 1) setBundleSelection(records);
    else if (entries[0].isDirectory) { selection = { kind: "folder", name: entries[0].name, files: records }; prepareSelection(); }
    else setFileSelection(records[0].file);
  }
  else if (event.dataTransfer.files.length) { const files = [...event.dataTransfer.files]; if (files.length === 1) setFileSelection(files[0]); else setBundleSelection(files.map((file) => ({ file, path: file.name }))); }
});
els.keyCopy.addEventListener("click", async () => {
  // The latest send wins: the one in progress, else the last finished one, else the current selection.
  const token = activeUpload?.symmetricKey ? `${activeUpload.sha}.${activeUpload.symmetricKey}`
    : lastSentToken || (payload ? `${payload.sha}.${payload.symmetricKey}` : "");
  if (!token) { setStatus("Send a file first.", "info"); return; }
  await navigator.clipboard.writeText(token);
  setStatus("File token copied to clipboard.", "ok");
});
els.loadToken.addEventListener("click", async () => {
  const value = els.downloadToken.value.trim();
  const match = value.match(/^([a-f0-9]{16}|[a-f0-9]{64})\.([A-Za-z0-9_-]+)$/i);
  if (!match) { setStatus("Enter a valid file token (ID.key).", "err"); return; }
  await chrome.storage.local.set({ [`${match[1]}.symmetricKey`]: match[2] });
  els.downloadToken.value = "";
  setStatus("File token loaded.", "ok");
  refreshFiles();
});
function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
els.exportStorage.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  for (const key of SETTINGS_KEYS) delete data[key];
  downloadJson("overshare-storage.json", data);
  setStatus("File tokens exported.", "ok");
});
els.importStorage.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("JSON must contain an object");
    await chrome.storage.local.set(data);
    els.downloadToken.value = "";
    setStatus("File tokens imported.", "ok");
    refreshFiles();
  } catch (error) { setStatus("Import failed: " + error.message, "err"); }
  event.target.value = "";
});
els.deleteStorage.addEventListener("click", async () => {
  const tokens = await storedKeys();
  if (!tokens.length) { setStatus("No stored file tokens to delete.", "info"); return; }
  if (!confirm(`Delete ${tokens.length} file token(s) and their Discord files? This cannot be undone.`)) return;
  try { requireConfig(); } catch (error) { setStatus("Delete failed: " + error.message, "err"); return; }
  els.downloadToken.value = "";
  startDelete([...shasFromKeys(tokens)], `${tokens.length} file(s)`);
});
els.mute.addEventListener("click", () => {
  muted = !muted;
  els.mute.textContent = muted ? "🔇" : "🔊";
  chrome.storage.local.set({ muted });
  if (!muted) playSound("click");
});
els.send.addEventListener("click", async () => {
  if (activeUpload) {
    activeUpload.canceling = true;
    refreshSendState();
    transferChannel.postMessage({ type: "cancelUpload" });
    return;
  }
  if (!payload) return;
  if (!config.token || !config.channelId) { setStatus("Set the bot token and channel ID first.", "err"); return; }
  els.send.disabled = true; els.send.textContent = "Starting…"; els.progress.style.display = "block"; els.bar.style.width = "0%";
  const metadata = { sha: payload.sha, name: payload.name, kind: payload.kind, originalSize: payload.originalSize };
  try {
    // File objects cross to the engine by reference; their contents are read there, piece by piece.
    transferChannel.postMessage({ type: "startUpload", job: { metadata, config, symmetricKey: payload.symmetricKey, files: payload.files } });
    activeUpload = { name: payload.name, sha: payload.sha, symmetricKey: payload.symmetricKey, total: null, sent: 0 };
    // Each send gets a fresh ID and key, so the selection is used up.
    clearSelection();
    refreshSendState();
  } catch (error) { setStatus("Send failed: " + error.message, "err"); refreshSendState(); }
});
els.fileList.addEventListener("scroll", loadIfAtBottom);
// Keeps the "5min ago" labels current while the popup stays open.
setInterval(() => { for (const when of els.fileList.querySelectorAll(".sent-at")) when.textContent = timeAgo(Number(when.dataset.time)); }, 60000);
els.tabSend.addEventListener("click", () => showTab(false)); els.tabDownload.addEventListener("click", () => showTab(true));
const transferChannel = new BroadcastChannel("overshare");
transferChannel.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "uploadState") applyUploadState(message.send);
  else if (message.type === "downloadState") applyDownloadState(message.state);
  else if (message.type === "deleteState") applyDeleteState(message.state);
};
els.botToken.addEventListener("input", onBotInput);
els.channelId.addEventListener("input", onBotInput);
// The engine records each finished send as lastFileToken, and clears it when that file is deleted.
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.lastFileToken) lastSentToken = changes.lastFileToken.newValue || ""; });
chrome.storage.local.get(["activeUpload", "muted", "lastFileToken", ...SETTINGS_KEYS], (data) => {
  lastSentToken = data.lastFileToken || "";
  muted = !!data.muted; els.mute.textContent = muted ? "🔇" : "🔊";
  config = { token: data.botToken || "", channelId: data.channelId || "" };
  els.botToken.value = config.token; els.channelId.value = config.channelId;
  // Restore the stored upload before asking the engine, so its reply can confirm or clear it.
  if (data.activeUpload) activeUpload = { ...data.activeUpload, restored: true };
  refreshSendState();
  chrome.runtime.sendMessage({ target: "background", type: "ensureEngine" }).then(() => transferChannel.postMessage({ type: "hello" })).catch(() => {});
  checkBot();
});
