"use strict";

const CHUNK_BYTES = 20 * 1024 * 1024;
const LOCAL_SERVER = "http://localhost:7878";
const ids = ["file", "folder", "folderBtn", "drop", "dropLabel", "send", "progress", "bar", "status", "version", "key", "keyAdd", "keyCopy", "serverStatus", "tabSend", "tabDownload", "sendPanel", "downloadPanel", "refreshFiles", "fileList", "exportStorage", "importStorage", "importFile", "mute"];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let selection = null;
let payload = null;
let preparing = false;
let muted = false;

els.version.textContent = "v" + chrome.runtime.getManifest().version;
function setStatus(message, kind = "info") { els.status.textContent = message; els.status.className = `status ${kind}`; }
function humanSize(bytes) { const units = ["B", "KB", "MB", "GB"]; let n = bytes, i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`; }
async function sha256hex(bytes) { const hash = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
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
  els.dropLabel.innerHTML = `<div class="name">${escapeHtml(selection.name)}${selection.kind === "folder" ? "/" : ""}</div><div class="size">Compressing ${selection.files.length} file(s)…</div>`;
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
    els.dropLabel.innerHTML = `<div class="name">${escapeHtml(selection.name)}${selection.kind === "folder" ? "/" : ""}</div><div class="size">${humanSize(payload.originalSize)} → ${humanSize(bytes.length)} encrypted · ${Math.ceil(bytes.length / CHUNK_BYTES)} chunks</div>`;
    els.key.value = `${sha}.${symmetricKey}`;
    await chrome.storage.local.set({ [`${sha}.symmetricKey`]: symmetricKey, lastKey: els.key.value });
    setStatus("Ready. The key was saved locally.", "ok");
  } catch (error) { setStatus("Preparation failed: " + error.message, "err"); els.dropLabel.textContent = "Click for a file, or drop a file / folder"; els.drop.classList.remove("has-file"); }
  finally { preparing = false; refreshSendState(); }
}
function refreshSendState() { els.send.disabled = !payload || preparing; }

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

async function checkServer() {
  try { const response = await fetch(`${LOCAL_SERVER}/health`); if (!response.ok) throw new Error(); els.serverStatus.textContent = "Local transfer server connected"; els.serverStatus.className = "tokenstatus ok"; }
  catch (_) { els.serverStatus.textContent = "Start the Python server on localhost:7878"; els.serverStatus.className = "tokenstatus bad"; }
}
function showTab(download) {
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
    const item = document.createElement("div"); item.className = "item";
    const meta = document.createElement("div"); meta.className = "meta";
    const name = document.createElement("div"); name.className = "fname"; name.textContent = file.name + (file.kind === "folder" ? "/" : "");
    const sub = document.createElement("div"); sub.className = file.available ? "sub" : "sub incomplete";
    sub.textContent = file.available ? `${humanSize(file.originalSize)} · ${file.total} chunk(s) · ${file.kind}` : file.manifestFound ? `${humanSize(file.originalSize)} · missing ${file.missingChunks} chunk(s)` : "missing from channel";
    meta.append(name, sub);
    const button = document.createElement("button"); button.textContent = "Download"; button.disabled = !file.available; button.addEventListener("click", () => downloadFile(file, button));
    item.append(meta, button); els.fileList.appendChild(item);
  }
}
async function refreshFiles() {
  els.fileList.innerHTML = '<div class="empty">Searching Discord…</div>';
  try {
    const response = await fetch(`${LOCAL_SERVER}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys: await storedKeys() }) });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const result = await response.json(); const files = result.files || []; renderFiles(files); const complete = files.filter((file) => file.available).length; const incomplete = files.length - complete; setStatus(`${complete} complete, ${incomplete} incomplete file(s).`, incomplete ? "info" : "ok");
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
  let dirHandle = null;
  try {
    if (file.kind === "folder" && window.showDirectoryPicker) dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    const keyData = await chrome.storage.local.get(`${file.sha}.symmetricKey`);
    const key = `${file.sha}.${keyData[`${file.sha}.symmetricKey`]}`;
    const response = await fetch(`${LOCAL_SERVER}/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
    const zip = new Uint8Array(await response.arrayBuffer()); const entries = fflate.unzipSync(zip); const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
    if (dirHandle) await saveFolder(dirHandle, entries);
    else if (file.kind === "file" && names.length === 1) await saveBytes(entries[names[0]], names[0].split("/").pop());
    else await saveBytes(zip, file.name.replace(/\/$/, "") + ".zip");
    playSound("download"); setStatus(`Downloaded ${file.name} ✓`, "ok");
  } catch (error) { if (error.name !== "AbortError") setStatus("Download failed: " + error.message, "err"); }
  finally { button.disabled = false; button.textContent = "Download"; }
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
els.keyCopy.addEventListener("click", async () => { if (els.key.value) { await navigator.clipboard.writeText(els.key.value); setStatus("Key copied to clipboard.", "ok"); } });
els.keyAdd.addEventListener("click", async () => {
  const value = els.key.value.trim();
  const match = value.match(/^([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/i);
  if (!match) { setStatus("Enter a valid SHA.symmetricKey value.", "err"); return; }
  await chrome.storage.local.set({ [`${match[1]}.symmetricKey`]: match[2], lastKey: value });
  setStatus("Recovery key added.", "ok");
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
  downloadJson("overshare-storage.json", await chrome.storage.local.get(null));
  setStatus("Storage exported.", "ok");
});
els.importStorage.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("JSON must contain an object");
    await chrome.storage.local.set(data);
    if (data.lastKey) els.key.value = data.lastKey;
    setStatus("Storage imported.", "ok");
  } catch (error) { setStatus("Import failed: " + error.message, "err"); }
  event.target.value = "";
});
els.mute.addEventListener("click", () => {
  muted = !muted;
  els.mute.textContent = muted ? "🔇" : "🔊";
  chrome.storage.local.set({ muted });
  if (!muted) playSound("click");
});
els.send.addEventListener("click", async () => { if (!payload) return; els.send.disabled = true; els.send.textContent = "Sending…"; els.progress.style.display = "block"; const total = Math.max(1, Math.ceil(payload.bytes.length / CHUNK_BYTES)); const metadata = { sha: payload.sha, name: payload.name, kind: payload.kind, originalSize: payload.originalSize, encryptedSize: payload.bytes.length, total }; try { const response = await fetch(`${LOCAL_SERVER}/upload`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-OverShare-Metadata": JSON.stringify(metadata) }, body: payload.bytes }); if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`); els.bar.style.width = "100%"; playSound("send"); setStatus(`Sent ${payload.name}: ${total} chunk(s) ✓`, "ok"); } catch (error) { setStatus("Send failed: " + error.message, "err"); } finally { els.send.disabled = false; els.send.textContent = "Send encrypted file"; } });
els.tabSend.addEventListener("click", () => showTab(false)); els.tabDownload.addEventListener("click", () => showTab(true)); els.refreshFiles.addEventListener("click", refreshFiles);
chrome.storage.local.get(["lastKey", "muted"], (data) => { if (data.lastKey) els.key.value = data.lastKey; muted = !!data.muted; els.mute.textContent = muted ? "🔇" : "🔊"; refreshSendState(); });
checkServer();
