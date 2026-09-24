"use strict";

const CHUNK_BYTES = 20 * 1024 * 1024;
const SETTINGS_KEYS = ["botToken", "channelId"];
const ids = ["file", "folder", "folderBtn", "drop", "dropLabel", "send", "progress", "bar", "status", "version", "keyCopy", "downloadToken", "loadToken", "deleteStorage", "botToken", "channelId", "botStatus", "botDot", "flyer", "tabs", "tabSend", "tabDownload", "sendPanel", "downloadPanel", "fileList", "downloadProgress", "downloadBar", "exportStorage", "importStorage", "importFile", "mute"];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let selection = null;
let payload = null;
let preparing = false;
let muted = false;
let activeUpload = null;
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
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
async function readBytes(file) { return new Uint8Array(await file.arrayBuffer()); }

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
async function prepareSelection() {
  if (!selection) return;
  preparing = true; payload = null; els.send.disabled = true; els.drop.classList.add("has-file");
  els.dropLabel.innerHTML = `<div class="name">${escapeHtml(selection.name)}${selection.kind === "folder" ? "/" : ""}</div><div class="size">Compressing ${selection.files.length} file(s)<span class="dots"></span></div>`;
  setStatus("Compressing…");
  try {
    const input = {};
    for (const record of selection.files) input[record.path] = [await readBytes(record.file), { level: 6, mtime: new Date(Date.UTC(1985, 0, 1)) }];
    const zipped = fflate.zipSync(input);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, zipped));
    const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
    const sha = await sha256hex(bytes); const symmetricKey = base64url(rawKey);
    payload = { kind: selection.kind, name: selection.name, bytes, sha, symmetricKey, originalSize: selection.files.reduce((n, r) => n + r.file.size, 0), entries: selection.files.length };
    els.dropLabel.innerHTML = `<div class="name">${escapeHtml(selection.name)}${selection.kind === "folder" ? "/" : ""}</div><div class="size">${humanSize(payload.originalSize)} → ${humanSize(bytes.length)} encrypted<br>${Math.ceil(bytes.length / CHUNK_BYTES)} chunks</div>`;
    setStatus("Ready. The file token will be stored after sending.", "ok");
    replayAnimation(els.drop, "pop");
    requestAnimationFrame(() => replayAnimation(els.send, "ready"));
  } catch (error) { setStatus("Preparation failed: " + error.message, "err"); els.dropLabel.textContent = "Click for a file, or drop a file / folder"; els.drop.classList.remove("has-file"); }
  finally { preparing = false; refreshSendState(); }
}
function refreshSendState() {
  if (activeUpload) {
    els.send.disabled = false;
    els.send.textContent = activeUpload.canceling ? "Canceling…" : "Cancel";
    els.send.classList.add("cancel");
    return;
  }
  els.send.classList.remove("cancel");
  els.send.textContent = "Send encrypted file";
  els.send.disabled = !payload || preparing;
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
    const chunk = `chunk ${Math.min((state.sent || 0) + 1, state.total || 1)}/${state.total || 1}`;
    setStatus(state.canceling ? `Canceling upload… ${percent}%` : `Sending ${chunk} · ${percent}% · ${transferStats(state)}`, "info");
  } else if (activeUpload) {
    // An idle reply can race a send this popup just started; only a restored upload should be cleared by it.
    if (state.idle && !activeUpload.restored) return;
    const old = activeUpload;
    activeUpload = null;
    resetUploadProgress();
    refreshSendState();
    if (state.outcome === "ok") { playSound("send"); setStatus(`Sent ${state.name || old.name}: ${state.total || old.total} chunk(s) 🚀`, "ok"); launchFlyer("🚀", "fly"); }
    else if (state.outcome === "canceled") {
      if (state.error?.includes("cleanup failed")) setStatus(state.error, "err");
      else setStatus("Upload canceled and partial Discord messages removed.", "info");
    }
    else if (state.outcome === "error") setStatus("Send failed: " + (state.error || "Upload failed"), "err");
    else if (state.idle && old.restored) {
      // The engine has no upload, but storage says one was running: the browser
      // closed mid-send. Its partial messages stay until the file is deleted.
      chrome.storage.local.remove(["activeUpload"]);
      setStatus(`Upload of ${old.name} was interrupted. Send it again.`, "err");
    }
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
function renderFiles(files) {
  els.fileList.textContent = "";
  if (!files.length) { els.fileList.innerHTML = '<div class="empty">No complete files found.</div>'; return; }
  for (const file of files) {
    const item = document.createElement("div"); item.className = "item"; item.style.setProperty("--i", els.fileList.children.length);
    const meta = document.createElement("div"); meta.className = "meta";
    const name = document.createElement("div"); name.className = "fname"; name.textContent = file.name + (file.kind === "folder" ? "/" : "");
    const sub = document.createElement("div"); sub.className = file.available ? "sub" : "sub incomplete";
    sub.textContent = file.available ? `${humanSize(file.originalSize)} · ${file.total} chunk(s) · ${file.kind}` : file.manifestFound ? `${humanSize(file.originalSize)} · missing ${file.missingChunks} chunk(s)` : "missing from channel";
    meta.append(name, sub);
    const actions = document.createElement("div"); actions.className = "item-actions";
    const button = document.createElement("button"); button.textContent = "Download"; button.disabled = !file.available; button.addEventListener("click", () => downloadFile(file, button));
    const copyButton = document.createElement("button"); copyButton.className = "copy-token"; copyButton.textContent = "Copy"; copyButton.title = "Copy file token";
    copyButton.addEventListener("click", () => copyFileToken(file, copyButton));
    const deleteButton = document.createElement("button"); deleteButton.className = "delete-file"; deleteButton.textContent = "Delete"; deleteButton.title = "Delete this file from Discord and local storage";
    deleteButton.addEventListener("click", () => deleteFileToken(file, deleteButton));
    const secondaryActions = document.createElement("div"); secondaryActions.className = "secondary-actions";
    secondaryActions.append(copyButton, deleteButton);
    actions.append(button, secondaryActions); item.append(meta, actions); els.fileList.appendChild(item);
  }
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
async function deleteFileToken(file, button) {
  const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
  const symmetricKey = keyData[`${file.sha}.symmetricKey`];
  if (!symmetricKey) { setStatus("Delete failed: token is not stored locally.", "err"); return; }
  if (!confirm(`Delete "${file.name}" from Discord and local storage? This cannot be undone.`)) return;
  button.disabled = true;
  try {
    requireConfig();
    await deleteTransfers(config, [file.sha]);
    await chrome.storage.local.remove([`${file.sha}.symmetricKey`]);
    const data = await chrome.storage.local.get(["lastFileToken", "lastKey"]);
    const token = `${file.sha}.${symmetricKey}`;
    await chrome.storage.local.remove([...(data.lastFileToken === token ? ["lastFileToken"] : []), ...(data.lastKey === token ? ["lastKey"] : [])]);
    setStatus(`Deleted ${file.name}.`, "ok");
    const item = button.closest(".item");
    item?.classList.add("removing");
    setTimeout(refreshFiles, item ? 280 : 0);
  } catch (error) { setStatus("Delete failed: " + error.message, "err"); }
  finally { button.disabled = false; }
}
async function refreshFiles() {
  if (!config.token || !config.channelId) { els.fileList.innerHTML = '<div class="empty">Set the bot token and channel ID first.</div>'; return; }
  els.fileList.innerHTML = '<div class="empty">Searching Discord…</div>';
  try {
    const { files } = await findTransfers(config, await storedKeys()); renderFiles(files); const complete = files.filter((file) => file.available).length; const incomplete = files.length - complete; setStatus(`${complete} complete, ${incomplete} incomplete file(s).`, incomplete ? "info" : "ok");
  } catch (error) { els.fileList.innerHTML = '<div class="empty">Could not search for files.</div>'; setStatus("Search failed: " + error.message, "err"); }
}
async function saveBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const result = await chrome.runtime.sendMessage({ target: "background", type: "download", url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  if (result?.error) throw new Error(result.error);
}
async function saveFolder(dirHandle, files) {
  for (const [path, bytes] of Object.entries(files)) {
    if (path.endsWith("/")) continue;
    const segments = path.split("/"); const filename = segments.pop(); let current = dirHandle;
    for (const segment of segments) if (segment) current = await current.getDirectoryHandle(segment, { create: true });
    const handle = await current.getFileHandle(filename, { create: true }); const writer = await handle.createWritable(); await writer.write(bytes); await writer.close();
  }
}
async function downloadFile(file, button) {
  button.disabled = true; button.textContent = "Downloading…";
  els.downloadProgress.style.display = "block"; els.downloadBar.style.width = "0%";
  let dirHandle = null;
  try {
    if (file.kind === "folder" && window.showDirectoryPicker) dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
    const key = `${file.sha}.${keyData[`${file.sha}.symmetricKey`]}`;
    requireConfig();
    let meter = null, lastUpdate = 0;
    setStatus(`Downloading ${file.name}…`, "info");
    const { zip } = await downloadTransfer(config, key, (done, totalBytes) => {
      meter ??= new TransferMeter(totalBytes);
      const stats = meter.update(done);
      const percent = Math.min(100, Math.round((done / totalBytes) * 100));
      els.downloadBar.style.width = percent + "%";
      if (performance.now() - lastUpdate < 250 && done < totalBytes) return;
      lastUpdate = performance.now();
      setStatus(`Downloading ${file.name} · ${percent}% · ${transferStats(stats)}`, "info");
    });
    setStatus(`Decrypting ${file.name}…`, "info"); const entries = fflate.unzipSync(zip); const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
    if (dirHandle) await saveFolder(dirHandle, entries);
    else if (file.kind === "file" && names.length === 1) await saveBytes(entries[names[0]], names[0].split("/").pop());
    else await saveBytes(zip, file.name.replace(/\/$/, "") + ".zip");
    els.downloadBar.style.width = "100%"; playSound("download"); setStatus(`Downloaded ${file.name} ✓`, "ok"); launchFlyer("📦", "drop-in");
  } catch (error) { if (error.name !== "AbortError") setStatus("Download failed: " + error.message, "err"); }
  finally { button.disabled = false; button.textContent = "Download"; setTimeout(() => { els.downloadProgress.style.display = "none"; }, 1200); }
}

els.drop.addEventListener("click", () => els.file.click());
els.file.addEventListener("change", (event) => { const files = [...event.target.files]; if (files.length === 1) setFileSelection(files[0]); else if (files.length) { selection = { kind: "multiplefiles", name: "overshare-bundle", files: files.map((file) => ({ file, path: file.name })) }; prepareSelection(); } });
els.folderBtn.addEventListener("click", () => els.folder.click());
els.folder.addEventListener("change", (event) => setFolderSelection(event.target.files));
els.drop.addEventListener("dragover", (event) => { event.preventDefault(); els.drop.classList.add("drag"); });
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("drag"));
els.drop.addEventListener("drop", async (event) => {
  event.preventDefault(); els.drop.classList.remove("drag"); const items = [...event.dataTransfer.items];
  if (items[0]?.webkitGetAsEntry) { const records = (await Promise.all(items.map((item) => item.webkitGetAsEntry()).filter(Boolean).map((entry) => readEntry(entry, "")))).flat(); if (records.length === 1 && !records[0].path.includes("/")) setFileSelection(records[0].file); else if (records.length) { selection = { kind: "folder", name: records[0].path.split("/")[0], files: records }; prepareSelection(); } }
  else if (event.dataTransfer.files.length) { const files = [...event.dataTransfer.files]; if (files.length === 1) setFileSelection(files[0]); else { selection = { kind: "multiplefiles", name: "overshare-bundle", files: files.map((file) => ({ file, path: file.name })) }; prepareSelection(); } }
});
els.keyCopy.addEventListener("click", async () => { if (payload?.symmetricKey) { await navigator.clipboard.writeText(`${payload.sha}.${payload.symmetricKey}`); setStatus("File token copied to clipboard.", "ok"); } else setStatus("Select a file first.", "info"); });
els.loadToken.addEventListener("click", async () => {
  const value = els.downloadToken.value.trim();
  const match = value.match(/^([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/i);
  if (!match) { setStatus("Enter a valid SHA.symmetricKey file token.", "err"); return; }
  await chrome.storage.local.set({ [`${match[1]}.symmetricKey`]: match[2], lastFileToken: value });
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
  els.deleteStorage.disabled = true;
  try {
    requireConfig();
    const deleted = await deleteTransfers(config, [...shasFromKeys(tokens)]);
    const data = await chrome.storage.local.get(null);
    const removals = Object.keys(data).filter((name) => name.endsWith(".symmetricKey") || name === "lastFileToken" || name === "lastKey");
    await chrome.storage.local.remove(removals);
    els.downloadToken.value = ""; els.fileList.innerHTML = '<div class="empty">No stored file tokens.</div>';
    setStatus(`Deleted ${deleted} Discord file message(s) and local token(s).`, "ok");
  } catch (error) { setStatus("Delete failed: " + error.message, "err"); }
  finally { els.deleteStorage.disabled = false; }
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
  if (!payload || preparing) return;
  if (!config.token || !config.channelId) { setStatus("Set the bot token and channel ID first.", "err"); return; }
  els.send.disabled = true; els.send.textContent = "Starting…"; els.progress.style.display = "block"; els.bar.style.width = "0%";
  const total = Math.max(1, Math.ceil(payload.bytes.length / CHUNK_BYTES));
  const metadata = { sha: payload.sha, name: payload.name, kind: payload.kind, originalSize: payload.originalSize, encryptedSize: payload.bytes.length, total };
  try {
    transferChannel.postMessage({ type: "startUpload", job: { metadata, config, symmetricKey: payload.symmetricKey, bytes: payload.bytes.buffer } }, [payload.bytes.buffer]);
    activeUpload = { name: payload.name, sha: payload.sha, total, sent: 0 };
    refreshSendState();
  } catch (error) { setStatus("Send failed: " + error.message, "err"); refreshSendState(); }
});
els.tabSend.addEventListener("click", () => showTab(false)); els.tabDownload.addEventListener("click", () => showTab(true));
const transferChannel = new BroadcastChannel("overshare");
transferChannel.onmessage = (event) => { if (event.data?.type === "uploadState") applyUploadState(event.data.send); };
els.botToken.addEventListener("input", onBotInput);
els.channelId.addEventListener("input", onBotInput);
chrome.storage.local.get(["activeUpload", "muted", ...SETTINGS_KEYS], (data) => {
  muted = !!data.muted; els.mute.textContent = muted ? "🔇" : "🔊";
  config = { token: data.botToken || "", channelId: data.channelId || "" };
  els.botToken.value = config.token; els.channelId.value = config.channelId;
  // Restore the stored upload before asking the engine, so its reply can confirm or clear it.
  if (data.activeUpload) activeUpload = { ...data.activeUpload, restored: true };
  refreshSendState();
  chrome.runtime.sendMessage({ target: "background", type: "ensureEngine" }).then(() => transferChannel.postMessage({ type: "hello" })).catch(() => {});
  checkBot();
});
