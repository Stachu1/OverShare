"use strict";

const ids = ["file", "folder", "folderBtn", "drop", "dropLabel", "send", "progress", "bar", "status", "version", "update", "keyCopy", "downloadToken", "loadToken", "deleteStorage", "botStatus", "botDot", "flyer", "tabs", "tabSend", "tabDownload", "sendPanel", "downloadPanel", "fileList", "downloadProgress", "downloadBar", "exportStorage", "importStorage", "importFile", "mute", "tooltip", "clearPick",
  "settingsBtn", "settingsPanel", "configLabel", "configList", "configDrop", "newConfig", "importConfigFile", "configForm", "configFormTitle", "configName", "configToken", "configChannel", "configOpen", "copyConfigName", "copyBotToken", "copyConfigChannel", "cancelConfig", "saveConfig",
  "dialog", "dialogMessage", "dialogOk", "dialogCancel"];
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
// A configuration is one bot and channel: { id, name, token, channelId, open }.
// open is true for an open channel (see OPEN_MASTER_KEY in shared.js).
const NO_CONFIG = { id: "", name: "", token: "", channelId: "", open: false };
let configs = [];
let config = NO_CONFIG;
let botCheckRun = 0;
let currentTab = "send", lastMainTab = "send";
let editingId = null; // the configuration the form is editing, or null for a new one

els.version.textContent = "v" + chrome.runtime.getManifest().version;
// An unpacked copy has no commit SHA of its own, but every commit bumps the manifest version,
// so the version on GitHub's main branch tells whether a newer commit is out.
// The API answers with the pushed file at once; raw.githubusercontent.com can lag up to 5 minutes
// behind a push, but has no rate limit, so it covers for the API's 60 requests an hour.
const REMOTE_MANIFESTS = [
  ["https://api.github.com/repos/Stachu1/OverShare/contents/manifest.json?ref=main", { Accept: "application/vnd.github.raw" }],
  ["https://raw.githubusercontent.com/Stachu1/OverShare/main/manifest.json", {}],
];
const UPDATE_CHECK_MS = 60 * 60 * 1000;
function newerVersion(remote, local) {
  const a = remote.split(".").map(Number), b = local.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
function showUpdate(remoteVersion) {
  els.update.hidden = !remoteVersion || !newerVersion(remoteVersion, chrome.runtime.getManifest().version);
  if (!els.update.hidden) els.update.dataset.tip = `v${remoteVersion} is on GitHub. Download the zip and load it in place of this one`;
}
async function checkForUpdate() {
  const { remoteVersion } = await chrome.storage.local.get("remoteVersion").catch(() => ({}));
  showUpdate(remoteVersion);
  for (const [url, headers] of REMOTE_MANIFESTS) {
    try {
      const response = await fetch(url, { cache: "no-store", headers });
      if (!response.ok) continue;
      const { version } = await response.json();
      if (typeof version !== "string") continue;
      showUpdate(version);
      await chrome.storage.local.set({ remoteVersion: version });
      return;
    } catch {} // offline or GitHub unreachable: keep the last known result
  }
}
checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_MS);
// Loading the new copy in place of this one wipes its storage, so the configurations are saved first.
// The zip is served as an attachment, so navigating the popup to it downloads it without leaving the page.
els.update.addEventListener("click", async (event) => {
  event.preventDefault();
  if (configs.length) {
    if (!await askConfirm(`The new version may start with empty storage.\n\nDownload your ${configs.length} configuration file(s) now? Import them again after the update. The update downloads right after.`, { ok: "Download" })) return;
    for (const item of configs) await exportConfig(item);
  }
  location.href = els.update.href;
});
// Asks in an overlay over the whole popup instead of the browser's own dialog.
// Resolves true for OK and false for Cancel or Escape; cancel: null shows OK alone.
// A danger OK (deleting, say) is red, and Cancel gets the focus so Enter is safe.
function askConfirm(message, { ok = "OK", cancel = "Cancel", danger = false } = {}) {
  const behind = [...document.body.children].filter((element) => element !== els.dialog);
  els.dialogMessage.textContent = message;
  els.dialogOk.textContent = ok;
  els.dialogOk.classList.toggle("danger", danger);
  els.dialogCancel.textContent = cancel || "";
  els.dialogCancel.hidden = !cancel;
  els.tooltip.classList.remove("show");
  for (const element of behind) element.inert = true;
  els.dialog.hidden = false;
  (danger && cancel ? els.dialogCancel : els.dialogOk).focus();
  return new Promise((resolve) => {
    const close = (answer) => {
      els.dialog.hidden = true;
      for (const element of behind) element.inert = false;
      els.dialogOk.onclick = els.dialogCancel.onclick = els.dialog.onkeydown = null;
      resolve(answer);
    };
    els.dialogOk.onclick = () => close(true);
    els.dialogCancel.onclick = () => close(false);
    els.dialog.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); close(!cancel); } };
  });
}
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
  if (config.open) setStatus("Ready to send to an open channel: anyone with this bot can download it.", "warn");
  else setStatus("Ready to send.", "ok");
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
    els.send.dataset.tip = "Stop the upload and remove the chunks already sent";
    return;
  }
  els.send.classList.remove("cancel");
  els.send.textContent = config.open ? "Send to Open Channel" : "Send";
  els.send.disabled = !payload;
  els.send.dataset.tip = !payload ? "Pick a file or folder first"
    : config.open ? "Compress, encrypt with OverShare's shared key and upload; anyone with this bot and OverShare can download it"
    : "Compress, encrypt and upload the selection to Discord";
}
// Open channels swap the token controls for a warning (the open-only and token-only classes in popup.html).
function applyOpenMode() {
  document.body.classList.toggle("open-channel", !!config.open);
  refreshSendState();
}
function resetUploadProgress() {
  els.progress.classList.remove("show");
  els.bar.style.width = "0%";
}
function applyUploadState(state) {
  if (state.active) {
    activeUpload = { ...activeUpload, ...state };
    els.progress.classList.add("show");
    const percent = state.totalBytes
      ? Math.min(100, Math.round((state.bytesSent / state.totalBytes) * 100))
      : Math.min(100, Math.round(((state.sent || 0) / (state.total || 1)) * 100));
    els.bar.style.width = percent + "%";
    // The chunk count is only known once compression ends, so until then it is the uncompressed upper bound.
    const chunks = state.total || Math.max(1, Math.ceil((state.totalBytes || 0) / PLAIN_CHUNK_BYTES));
    const chunkLabel = `${state.total ? "" : "~"}${chunks} chunk${chunks === 1 ? "" : "s"}`;
    if (state.cleaning) setStatus(`Removing sent chunks of ${state.name}…`, "info");
    else if (state.canceling) setStatus(`Canceling upload… ${percent}%`, "info");
    else if (state.retrying) setStatus(`Chunk ${state.retrying.chunk} got no answer from Discord; resending (attempt ${state.retrying.attempt} of ${state.retrying.of}) · ${percent}%`, "info");
    else setStatus(`Sending ${chunkLabel} · ${percent}% · ${transferStats(state)}`, "info");
    refreshSendState();
  } else if (activeUpload || state.outcome === "interrupted") {
    // An idle reply can race a send this popup just started; only a restored upload should be cleared by it.
    if (state.idle && !activeUpload.restored) return;
    const old = activeUpload;
    activeUpload = null;
    resetUploadProgress();
    refreshSendState();
    if (state.idle) return;
    if (state.outcome === "ok") { if (old.symmetricKey && old.configId === config.id) lastSentToken = `${old.sha}.${old.symmetricKey}`; playSound("send"); setStatus(`Sent ${state.name || old.name}${old.open ? " to the open channel" : ""}: ${humanSize(state.size || 0)} (${humanSize(state.speed || 0)}/s)`, "ok"); launchFlyer("🚀", "fly"); }
    else setStatus(state.text || "Upload failed", state.failed ? "err" : "info");
  }
}

// Flashes a copy button's glow and briefly swaps its label to confirm the copy.
function flashCopied(button) {
  replayAnimation(button, "copied");
  button.dataset.label ??= button.textContent;
  button.textContent = "Copied!";
  clearTimeout(button.copiedTimer);
  button.copiedTimer = setTimeout(() => { button.textContent = button.dataset.label; }, 1200);
}

// Hover descriptions: one shared tooltip, kept inside the popup's edges.
let tipTarget = null, tipTimer = 0;
function showTip(target) {
  els.tooltip.textContent = target.dataset.tip;
  const box = target.getBoundingClientRect(), tip = els.tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(6, box.left + box.width / 2 - tip.width / 2), innerWidth - tip.width - 6);
  const top = box.bottom + 6 + tip.height < innerHeight ? box.bottom + 6 : box.top - tip.height - 6;
  els.tooltip.style.left = left + "px"; els.tooltip.style.top = top + "px";
  els.tooltip.classList.add("show");
}
function hideTip() { clearTimeout(tipTimer); tipTarget = null; els.tooltip.classList.remove("show"); }
document.addEventListener("mouseover", (event) => {
  const target = event.target.closest("[data-tip]");
  if (target === tipTarget) return;
  hideTip();
  if (!target) return;
  tipTarget = target;
  tipTimer = setTimeout(() => showTip(target), 1000);
});
document.addEventListener("mousedown", hideTip);
document.addEventListener("scroll", hideTip, true);

function launchFlyer(emoji, className) {
  els.flyer.textContent = emoji;
  els.flyer.className = "flyer";
  replayAnimation(els.flyer, className);
}

// The audio starts when the popup opens, and is resumed on any press (Chrome keeps it
// suspended until a user gesture), so a sound on press plays at once instead of
// waiting for the audio device to wake up.
let audioContext = null;
function audio() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return audioContext;
}
try { audio(); } catch (_) {}
document.addEventListener("pointerdown", () => { try { audio(); } catch (_) {} }, true);
function playTone(frequency, duration, delay = 0, { type = "sine", volume = 0.04 } = {}) {
  if (muted) return;
  try {
    audio();
    const start = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.01);
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
  if (name === "connected") { playTone(880, 0.08); playTone(1175, 0.16, 0.08); }
  // A buzzy sawtooth, louder than the other sounds, so a failure is hard to miss.
  if (name === "failed") { const buzz = { type: "sawtooth", volume: 0.09 }; playTone(311, 0.13, 0, buzz); playTone(208, 0.3, 0.14, buzz); }
}
// Ratchet clicks for the settings gear's spin: one per SPIN_TOOTH_DEG of turn, timed
// along the spin's easing curve (gear-open in popup.html), so they come fast while it
// spins fast and slow down as it stops.
const SPIN_SECONDS = 0.9, SPIN_DEG = 1080, SPIN_TOOTH_DEG = 45, SPIN_EASING = [0.2, 0.8, 0.2, 1];
const spinClickTimes = (() => {
  const [x1, y1, x2, y2] = SPIN_EASING;
  const bezier = (s, a, b) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const teeth = SPIN_DEG / SPIN_TOOTH_DEG, times = [0]; // the first click comes with the press
  for (let step = 1, next = 1; step <= 2000 && next <= teeth; step++) {
    const s = step / 2000;
    while (next <= teeth && bezier(s, y1, y2) * teeth >= next - 1e-9) { times.push(bezier(s, x1, x2) * SPIN_SECONDS); next++; }
  }
  return times;
})();
// A click is a few milliseconds of noise that dies away at once, through a band-pass
// filter that sets its pitch: a tick, not a tone.
let clickNoise = null;
function playClicks(times, pitch) {
  if (muted) return;
  try {
    const context = audio();
    if (!clickNoise) {
      const length = Math.round(context.sampleRate * 0.004);
      clickNoise = context.createBuffer(1, length, context.sampleRate);
      const samples = clickNoise.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length / 5));
    }
    const now = context.currentTime;
    times.forEach((time, tooth) => {
      const source = context.createBufferSource(); source.buffer = clickNoise;
      const filter = context.createBiquadFilter(); filter.type = "bandpass"; filter.frequency.value = pitch(tooth); filter.Q.value = 2;
      const gain = context.createGain(); gain.gain.value = 0.5;
      source.connect(filter).connect(gain).connect(context.destination);
      source.start(now + time);
    });
  } catch (_) {}
}
function playSpinClicks() { playClicks(spinClickTimes, (tooth) => tooth % 2 ? 3200 : 4000); }
let hoveredButton = null;
document.addEventListener("mouseover", (event) => { const button = event.target.closest("button"); if (button && button !== hoveredButton) { hoveredButton = button; playSound("hover"); } });
document.addEventListener("mouseout", (event) => { if (!event.relatedTarget?.closest?.("button")) hoveredButton = null; });
document.addEventListener("click", (event) => { const button = event.target.closest("button"); if (button && button !== els.mute && button !== els.settingsBtn) playSound("click"); }, true);

let botState = "checking";
// The header dot, the status line and the "In use" label of the configuration list follow the bot check.
function setBotStatus(message, kind) {
  botState = kind;
  els.botStatus.textContent = message; els.botStatus.className = `tokenstatus ${kind}`;
  els.botDot.className = `dot ${kind}`;
  const inUse = els.configList.querySelector(".in-use");
  if (inUse) { inUse.className = `in-use ${kind}`; inUse.title = message; }
}
// Resolves true when connected, false on an error, and null when a newer check took over.
async function checkBot() {
  const run = ++botCheckRun;
  if (!config.id) { setBotStatus("No configuration: add one in ⚙️ Settings", "bad"); return false; }
  setBotStatus("Checking bot…", "checking");
  try {
    const bot = await discordRequest(config, "GET", "/users/@me");
    const target = await discordRequest(config, "GET", `/channels/${config.channelId}`);
    if (run !== botCheckRun) return null;
    // The channel's name decides whether it is open, so a renamed channel is followed.
    const open = isOpenChannelName(target.name);
    if (!!config.open !== open) {
      config = { ...config, open };
      configs = configs.map((item) => item.id === config.id ? config : item);
      await chrome.storage.local.set({ configs });
      if (run !== botCheckRun) return null;
      applyOpenMode();
      renderConfigs();
      if (currentTab === "download") refreshFiles();
    }
    setBotStatus(`Connected as ${bot.username} · ${target.name ? "#" + target.name : "DM"}`, "ok");
    return true;
  } catch (error) {
    if (run !== botCheckRun) return null;
    setBotStatus(error.message, "bad");
    return false;
  }
}
function requireConfig() { if (!config.id) throw new Error("add a configuration in Settings first"); }
// name is "send", "download" or "settings".
// Settings hides the tabs; closing it goes back to the tab that was open.
function showTab(name) {
  currentTab = name;
  els.tabs.hidden = name === "settings";
  if (name !== "settings") {
    lastMainTab = name;
    els.tabs.classList.toggle("download", name === "download");
    els.tabSend.classList.toggle("active", name === "send"); els.tabDownload.classList.toggle("active", name === "download");
  }
  els.sendPanel.classList.toggle("active", name === "send"); els.downloadPanel.classList.toggle("active", name === "download");
  els.settingsPanel.classList.toggle("active", name === "settings"); els.settingsBtn.classList.toggle("active", name === "settings");
  if (name === "download") refreshFiles();
  saveViewState();
}
// The popup closes whenever it loses focus, so the open tab and a half-filled new
// configuration are kept in session storage (memory only, cleared when the browser
// closes). Reopening the popup, say after copying the bot token, lands back there.
function saveViewState() {
  const form = els.configForm.hidden ? null : { editingId, name: els.configName.value, token: els.configToken.value, channelId: els.configChannel.value, open: els.configOpen.checked };
  chrome.storage.session.set({ view: { tab: currentTab, lastMainTab, form } }).catch(() => {});
}
async function restoreViewState() {
  const { view } = await chrome.storage.session.get("view").catch(() => ({}));
  if (!configs.length) showTab("settings");
  else if (view) { lastMainTab = view.lastMainTab || "send"; showTab(view.tab || "send"); }
  // With nothing set up yet, Settings opens with the new configuration form.
  if (!view?.form && configs.length) return;
  openConfigForm(true, configs.find((item) => item.id === view?.form?.editingId));
  if (view?.form) {
    els.configName.value = view.form.name || ""; els.configToken.value = view.form.token || ""; els.configChannel.value = view.form.channelId || "";
    els.configOpen.checked = !!view.form.open;
    updateOpenBox();
    saveViewState();
  }
}
async function storedKeys() { return configTokens(await chrome.storage.local.get(null), config.id); }
async function storedKey(sha) {
  if (config.open) return OPEN_MASTER_KEY;
  const name = tokenKey(config.id, sha);
  return (await chrome.storage.local.get(name))[name];
}

// ---- Configurations ----

function newConfigId() { return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
// Before 5.0 there was a single bot, stored as botToken and channelId, with file
// tokens stored as "<id>.symmetricKey". They become the first configuration.
async function migrateLegacyStorage(data) {
  const legacyTokens = Object.keys(data).filter((name) => !name.includes(":") && name.endsWith(".symmetricKey"));
  const items = { configs: [] };
  if (data.botToken || data.channelId || legacyTokens.length) {
    const id = newConfigId();
    items.configs.push({ id, name: "Default", token: data.botToken || "", channelId: data.channelId || "" });
    items.activeConfigId = id;
    for (const name of legacyTokens) items[`${id}:${name}`] = data[name];
    if (data.lastFileToken) items[lastTokenKey(id)] = data.lastFileToken;
  }
  await chrome.storage.local.set(items);
  await chrome.storage.local.remove(["botToken", "channelId", "lastFileToken", "lastKey", ...legacyTokens]);
}
function renderConfigs() {
  els.configList.textContent = "";
  if (!configs.length) els.configList.innerHTML = '<div class="empty">No configurations yet.</div>';
  configs.forEach((item, position) => {
    const current = item.id === config.id;
    const row = document.createElement("div"); row.className = current ? "item config-item current" : "item config-item"; row.style.setProperty("--i", position);
    if (!current) row.dataset.tip = "Use this configuration";
    const meta = document.createElement("div"); meta.className = "meta";
    const name = document.createElement("div"); name.className = "fname"; name.textContent = item.name;
    const sub = document.createElement("div"); sub.className = "sub";
    sub.innerHTML = `${current ? `<span class="in-use ${botState}" title="${escapeHtml(els.botStatus.textContent)}">In use</span> · ` : ""}Channel ${escapeHtml(item.channelId)}${item.open ? ' · <span class="open-tag">Open</span>' : ""}`;
    meta.append(name, sub);
    const actions = document.createElement("div"); actions.className = "secondary-actions";
    const editButton = document.createElement("button"); editButton.className = "copy-token"; editButton.textContent = "Edit";
    editButton.dataset.tip = "Change this configuration's name, bot token or channel ID";
    editButton.addEventListener("click", (event) => { event.stopPropagation(); hideTip(); openConfigForm(true, item); });
    const exportButton = document.createElement("button"); exportButton.className = "copy-token"; exportButton.textContent = "Export";
    exportButton.dataset.tip = "Save this configuration, with its bot token, channel ID and file tokens, to a JSON file";
    exportButton.addEventListener("click", (event) => { event.stopPropagation(); exportConfig(item); });
    const deleteButton = document.createElement("button"); deleteButton.className = "delete-file"; deleteButton.textContent = "Delete";
    deleteButton.dataset.tip = "Remove this configuration and its file tokens from the extension; its files stay on Discord";
    deleteButton.addEventListener("click", (event) => { event.stopPropagation(); deleteConfig(item); });
    actions.append(editButton, exportButton, deleteButton);
    row.append(meta, actions);
    if (!current) row.addEventListener("click", async () => { hideTip(); await selectConfig(item.id, { sound: true }); setStatus(`Switched to ${item.name}.`, "ok"); });
    els.configList.append(row);
  });
  els.configLabel.textContent = config.id ? config.name : "Discord bot";
}
// With sound, the bot check ends with a success or failure sound.
async function selectConfig(id, { sound = false } = {}) {
  config = configs.find((item) => item.id === id) || NO_CONFIG;
  const data = await chrome.storage.local.get(lastTokenKey(config.id));
  await chrome.storage.local.set({ activeConfigId: config.id });
  lastSentToken = data[lastTokenKey(config.id)] || "";
  els.downloadToken.value = "";
  renderConfigs();
  applyOpenMode();
  // The file list belongs to the old configuration; it is rebuilt when the Download tab opens.
  listRun++; scanner = null; itemControls.clear();
  if (currentTab === "download") refreshFiles();
  checkBot().then((connected) => { if (sound && connected !== null) playSound(connected ? "connected" : "failed"); });
}
function uniqueConfigName(name) {
  const taken = new Set(configs.map((item) => item.name.toLowerCase()));
  let candidate = name, n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} (${n++})`;
  return candidate;
}
// Stored file tokens in the export file format: { "<id>.symmetricKey": key }.
function tokenFileEntries(tokens) { return Object.fromEntries(tokens.map((token) => { const [sha, key] = token.split("."); return [`${sha}.symmetricKey`, key]; })); }
// Reads [id, key] pairs from a token export, or from a configuration export's file tokens.
function tokensFromFile(data) {
  const source = data?.overshareConfig ? data.files : data;
  if (!source || Array.isArray(source) || typeof source !== "object") throw new Error("JSON must contain an object");
  return Object.entries(source)
    .map(([name, value]) => [name.match(/^([a-f0-9]{16}|[a-f0-9]{64})\.symmetricKey$/i)?.[1], value])
    .filter(([sha, value]) => sha && typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value));
}
function tokenItems(configId, pairs) { return Object.fromEntries(pairs.map(([sha, key]) => [tokenKey(configId, sha), key])); }
function busyWithConfig() { return !!activeUpload || !!activeDownload || deletingShas.size > 0; }
// item is the configuration to edit; without it the form adds a new one.
function openConfigForm(open, item = null) {
  els.configForm.hidden = !open;
  els.newConfig.disabled = open;
  editingId = open && item ? item.id : null;
  if (open) {
    els.configFormTitle.textContent = item ? `Edit ${item.name}` : "New configuration";
    els.configName.value = item ? item.name : configs.length ? "" : "Default";
    els.configToken.value = item?.token || ""; els.configChannel.value = item?.channelId || "";
    els.configOpen.checked = !!item?.open;
    updateOpenBox();
    for (const button of [els.copyConfigName, els.copyBotToken, els.copyConfigChannel]) button.hidden = !item;
    (item || configs.length ? els.configName : els.configToken).focus();
  }
  saveViewState();
}
// Only a new channel can be made open: marking an existing one would hand its files to
// everyone with the bot, against the wishes of whoever keeps it private. An ID names an
// existing channel, so the box is locked then and shows whether that channel is open.
function updateOpenBox() {
  const channelInput = els.configChannel.value.trim(), isId = /^\d+$/.test(channelInput);
  if (isId) { const edited = configs.find((item) => item.id === editingId); els.configOpen.checked = !!edited?.open && edited.channelId === channelInput; }
  els.configOpen.disabled = isId;
}
function updateItemButtons() {
  for (const [sha, { file, downloadButton, deleteButton }] of itemControls) {
    const downloading = activeDownload?.sha === sha, deleting = deletingShas.has(sha);
    downloadButton.disabled = !file.available || !!activeDownload || deleting;
    downloadButton.textContent = !downloading ? "Download" : activeDownload.phase === "saving" ? "Saving…" : `${activeDownload.percent || 0}%`;
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
  const button = document.createElement("button"); button.textContent = "Download"; button.dataset.tip = "Download, decrypt and save this file"; button.addEventListener("click", () => downloadFile(file));
  const copyButton = document.createElement("button"); copyButton.className = "copy-token"; copyButton.textContent = "Copy"; copyButton.dataset.tip = "Copy this file's token to share it";
  copyButton.addEventListener("click", () => copyFileToken(file, copyButton));
  const deleteButton = document.createElement("button"); deleteButton.className = "delete-file"; deleteButton.textContent = "Delete"; deleteButton.dataset.tip = "Delete this file from Discord and local storage";
  deleteButton.addEventListener("click", () => deleteFileToken(file));
  const secondaryActions = document.createElement("div"); secondaryActions.className = "secondary-actions";
  // Everyone with the bot sees an open channel's files, so there is no token to share.
  if (config.open) secondaryActions.append(deleteButton);
  else secondaryActions.append(copyButton, deleteButton);
  actions.append(button, secondaryActions); item.append(meta, actions);
  itemControls.set(file.sha, { file, item, downloadButton: button, deleteButton });
  return item;
}
async function copyFileToken(file, button) {
  try {
    const symmetricKey = await storedKey(file.sha);
    if (!symmetricKey) throw new Error("token is not stored locally");
    await navigator.clipboard.writeText(`${file.sha}.${symmetricKey}`);
    flashCopied(button);
    setStatus("File token copied to clipboard.", "ok");
  } catch (error) { setStatus("Copy failed: " + error.message, "err"); }
}
async function deleteFileToken(file) {
  if (!await storedKey(file.sha)) { setStatus("Delete failed: token is not stored locally.", "err"); return; }
  const question = config.open ? `Delete "${file.name}" from the open channel? It goes for everyone who shares it. This cannot be undone.`
    : `Delete "${file.name}" from Discord and local storage? This cannot be undone.`;
  if (!await askConfirm(question, { ok: "Delete", danger: true })) return;
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
  if (!config.id) { els.fileList.innerHTML = '<div class="empty">Add a configuration in ⚙️ Settings first.</div>'; return; }
  els.fileList.textContent = "";
  listFooter = document.createElement("div"); listFooter.className = "empty";
  els.fileList.appendChild(listFooter);
  const keys = await storedKeys();
  if (run !== listRun) return;
  scanner = new TransferScanner(config, config.open ? null : keys);
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
    const key = `${file.sha}.${await storedKey(file.sha)}`;
    activeDownload = { active: true, sha: file.sha, name: file.name, phase: "downloading", done: 0, totalBytes: 0 };
    applyDownloadState(activeDownload);
    transferChannel.postMessage({ type: "startDownload", job: { config, key, sha: file.sha, name: file.name, kind: file.kind, dirHandle } });
  } catch (error) { if (error.name !== "AbortError") setStatus("Download failed: " + error.message, "err"); }
}
function applyDownloadState(state) {
  if (state.active) {
    activeDownload = state;
    els.downloadProgress.classList.add("show");
    const percent = state.phase === "saving" ? 100 : state.totalBytes ? Math.min(100, Math.round((state.done / state.totalBytes) * 100)) : 0;
    activeDownload.percent = percent;
    els.downloadBar.style.width = percent + "%";
    if (state.phase === "saving") setStatus(`Decrypting and saving ${state.name}…`, "info");
    else setStatus(`Downloading ${state.name} · ${percent}% · ${transferStats(state)}`, "info");
  } else {
    if (activeDownload?.sha === state.sha) activeDownload = null;
    if (state.outcome === "ok") { els.downloadBar.style.width = "100%"; playSound("download"); setStatus(state.text, "ok"); launchFlyer("📦", "drop-in"); }
    else setStatus(state.text, "err");
    if (!activeDownload) setTimeout(() => { if (!activeDownload) els.downloadProgress.classList.remove("show"); }, 1200);
  }
  updateItemButtons();
}

els.drop.addEventListener("click", () => els.file.click());
els.clearPick.addEventListener("click", (event) => {
  event.stopPropagation();
  hideTip();
  clearSelection();
  refreshSendState();
  setStatus("Selection cleared.", "info");
});
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
  flashCopied(els.keyCopy);
  setStatus("File token copied to clipboard.", "ok");
});
els.downloadToken.addEventListener("keydown", (event) => { if (event.key === "Enter") els.loadToken.click(); });
els.loadToken.addEventListener("click", async () => {
  const value = els.downloadToken.value.trim();
  const match = value.match(/^([a-f0-9]{16}|[a-f0-9]{64})\.([A-Za-z0-9_-]+)$/i);
  if (!match) { setStatus("Enter a valid file token (ID.key).", "err"); return; }
  if (!config.id) { setStatus("Add a configuration in Settings first.", "err"); return; }
  await chrome.storage.local.set({ [tokenKey(config.id, match[1])]: match[2] });
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
// Token exports hold only file tokens, never the bot token or channel ID.
els.exportStorage.addEventListener("click", async () => {
  if (!config.id) { setStatus("Add a configuration in Settings first.", "err"); return; }
  const tokens = await storedKeys();
  downloadJson("overshare-tokens.json", tokenFileEntries(tokens));
  setStatus(`${tokens.length} file token(s) exported.`, "ok");
});
els.importStorage.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    requireConfig();
    const pairs = tokensFromFile(JSON.parse(await file.text()));
    if (!pairs.length) throw new Error("no file tokens found in the file");
    await chrome.storage.local.set(tokenItems(config.id, pairs));
    els.downloadToken.value = "";
    setStatus(`${pairs.length} file token(s) imported into ${config.name}.`, "ok");
    refreshFiles();
  } catch (error) { setStatus("Import failed: " + error.message, "err"); }
  event.target.value = "";
});
els.deleteStorage.addEventListener("click", async () => {
  const tokens = await storedKeys();
  if (!tokens.length) { setStatus("No stored file tokens to delete.", "info"); return; }
  if (!await askConfirm(`Delete ${tokens.length} file token(s) and their Discord files? This cannot be undone.`, { ok: "Delete all", danger: true })) return;
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
  if (!config.id) { setStatus("Add a configuration in Settings first.", "err"); return; }
  els.send.disabled = true; els.send.textContent = "Starting…"; els.progress.classList.add("show"); els.bar.style.width = "0%";
  const metadata = { sha: payload.sha, name: payload.name, kind: payload.kind, originalSize: payload.originalSize };
  const symmetricKey = config.open ? OPEN_MASTER_KEY : payload.symmetricKey;
  try {
    // File objects cross to the engine by reference; their contents are read there, piece by piece.
    transferChannel.postMessage({ type: "startUpload", job: { metadata, config, symmetricKey, files: payload.files } });
    activeUpload = { name: payload.name, sha: payload.sha, symmetricKey, configId: config.id, open: !!config.open, total: null, sent: 0 };
    // Each send gets a fresh ID and key, so the selection is used up.
    clearSelection();
    refreshSendState();
  } catch (error) { setStatus("Send failed: " + error.message, "err"); refreshSendState(); }
});
els.fileList.addEventListener("scroll", loadIfAtBottom);
// Keeps the "5min ago" labels current while the popup stays open.
setInterval(() => { for (const when of els.fileList.querySelectorAll(".sent-at")) when.textContent = timeAgo(Number(when.dataset.time)); }, 60000);
els.tabSend.addEventListener("click", () => showTab("send")); els.tabDownload.addEventListener("click", () => showTab("download"));
// The gear turns on press, not on release; the click event is kept for the keyboard.
function toggleSettings() {
  const opening = currentTab !== "settings";
  els.settingsBtn.classList.remove("spin-open", "spin-close");
  replayAnimation(els.settingsBtn, opening ? "spin-open" : "spin-close");
  playSpinClicks();
  showTab(opening ? "settings" : lastMainTab);
}
els.settingsBtn.addEventListener("pointerdown", (event) => { if (event.button === 0) toggleSettings(); });
els.settingsBtn.addEventListener("click", (event) => { if (event.detail === 0) toggleSettings(); });

els.newConfig.addEventListener("click", () => openConfigForm(true));
els.cancelConfig.addEventListener("click", () => openConfigForm(false));
for (const field of [els.configName, els.configToken, els.configChannel]) field.addEventListener("input", saveViewState);
els.configChannel.addEventListener("input", updateOpenBox);
els.configOpen.addEventListener("change", saveViewState);
// The copy buttons inside the edit form's fields; the bot token is copied only after a warning.
function copyField(button, field, what, { warning = "", done = `${what[0].toUpperCase()}${what.slice(1)} copied.` } = {}) {
  button.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) { setStatus(`There is no ${what} to copy.`, "info"); return; }
    if (warning && !await askConfirm(warning, { ok: "Copy", danger: true })) return;
    await navigator.clipboard.writeText(value);
    replayAnimation(button, "copied");
    setStatus(done, warning ? "warn" : "ok");
  });
}
copyField(els.copyConfigName, els.configName, "configuration name");
copyField(els.copyConfigChannel, els.configChannel, "channel ID");
copyField(els.copyBotToken, els.configToken, "bot token", {
  warning: "The bot token gives full control of the bot: whoever has it can read, send and delete everything the bot can reach.\n\nShare it only with people you trust.",
  done: "Bot token copied. Keep it private.",
});
// Finds the text channel called name in the bot's server, or creates it after
// asking. The server is the one of another configuration with the same bot, and
// the new channel goes in that channel's category; otherwise the bot must be in
// exactly one server. Resolves to the channel, or null when the user says no.
async function findOrCreateChannel(token, name) {
  const request = (method, path, json) => discordRequest({ token, channelId: name }, method, path, { json });
  const fail = (message) => { throw Object.assign(new Error(message), { channelSetup: true }); };
  // Discord lowercases text channel names and turns spaces into dashes.
  const wanted = name.toLowerCase().replace(/\s+/g, "-");
  let guildId = null, parentId = null;
  for (const item of configs.filter((other) => other.token === token)) {
    try { const sibling = await request("GET", `/channels/${item.channelId}`); guildId = sibling.guild_id; parentId = sibling.parent_id || null; break; } catch (_) {}
  }
  const guilds = await request("GET", "/users/@me/guilds");
  const guild = guildId ? guilds.find((item) => item.id === guildId) : guilds.length === 1 ? guilds[0] : null;
  if (!guild) fail(guilds.length ? `The bot is in ${guilds.length} servers, so it can't tell where to create #${wanted}. Enter a channel ID instead.` : "The bot is not in any server yet; invite it to yours first.");
  const existing = (await request("GET", `/guilds/${guild.id}/channels`)).find((channel) => channel.type === 0 && channel.name === wanted);
  if (existing) return existing;
  if (!await askConfirm(`No channel #${wanted} exists in ${guild.name}. Create it?`, { ok: "Create" })) return null;
  try {
    return await request("POST", `/guilds/${guild.id}/channels`, { name, type: 0, ...(parentId ? { parent_id: parentId } : {}) });
  } catch (error) {
    if (error.status === 403) fail(`The bot may not create channels in ${guild.name}; give it the Manage Channels permission.`);
    throw error;
  }
}
els.configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = els.configName.value.trim(), token = els.configToken.value.trim(), channelInput = els.configChannel.value.trim();
  const wantOpen = els.configOpen.checked;
  if (!name || !token || !channelInput) { setStatus("Fill in the name, bot token and channel ID or name.", "err"); return; }
  if (configs.some((item) => item.id !== editingId && item.name.toLowerCase() === name.toLowerCase())) { setStatus(`A configuration named ${name} already exists.`, "err"); return; }
  const edited = configs.find((item) => item.id === editingId);
  let channelId = channelInput, open = !!edited?.open;
  // A rename alone needs no new check with Discord.
  if (!edited || edited.token !== token || edited.channelId !== channelInput || open !== wantOpen) {
    els.saveConfig.disabled = true;
    setStatus("Checking bot…", "info");
    // Anything that is not an existing channel's ID is taken as the name of a new channel.
    let isName = !/^\d+$/.test(channelInput);
    try {
      if (!isName) {
        try {
          open = isOpenChannelName((await discordRequest({ token, channelId }, "GET", `/channels/${channelId}`)).name);
        } catch (error) {
          // 10003 is Unknown Channel; 50035 is a number too long to be an ID.
          if (error.code !== 10003 && error.code !== 50035) throw error;
          isName = true;
        }
      }
      if (isName) {
        // Open adds the prefix to a new channel's name; a name that has it already is open anyway.
        const channelName = wantOpen && !isOpenChannelName(channelInput) ? OPEN_PREFIX + channelInput : channelInput;
        setStatus(`Setting up channel ${channelName}…`, "info");
        const created = await findOrCreateChannel(token, channelName);
        if (!created) { setStatus("No channel was created.", "info"); els.saveConfig.disabled = false; return; }
        channelId = created.id;
        open = isOpenChannelName(created.name);
      }
    } catch (error) {
      // Without a channel ID there is nothing to save.
      if (isName) { setStatus(error.channelSetup ? error.message : "Setting up the channel failed: " + error.message, "err"); els.saveConfig.disabled = false; return; }
      // A wrong token (401) is saved without asking; its red "In use" label shows the problem.
      // The channel couldn't be read, so it keeps what the locked box shows (the saved state of
      // the same channel, else not open) until the bot check can read its name.
      open = wantOpen;
      if (error.status !== 401 && !await askConfirm(`Discord check failed: ${error.message}\n\nSave the configuration anyway?`, { ok: "Save anyway" })) { setStatus("Check failed: " + error.message, "err"); els.saveConfig.disabled = false; return; }
    }
    els.saveConfig.disabled = false;
  }
  const id = edited?.id || newConfigId();
  configs = edited ? configs.map((item) => item.id === id ? { id, name, token, channelId, open } : item) : [...configs, { id, name, token, channelId, open }];
  await chrome.storage.local.set({ configs });
  openConfigForm(false);
  // Editing another configuration leaves the one in use selected.
  if (!edited || id === config.id) await selectConfig(id);
  else renderConfigs();
  setStatus(`Configuration ${name} ${edited ? "saved" : "added"}${open ? " with an open channel: anyone with this bot can see its files" : ""}.`, "ok");
});
// A configuration export holds everything needed to use it elsewhere, bot token included.
async function exportConfig(item) {
  const tokens = configTokens(await chrome.storage.local.get(null), item.id);
  const safeName = item.name.replace(/[^\w-]+/g, "_");
  downloadJson(`overshare-config-${safeName}.json`, { overshareConfig: 1, name: item.name, botToken: item.token, channelId: item.channelId, open: !!item.open, files: tokenFileEntries(tokens) });
  setStatus(`${item.name} exported with ${tokens.length} file token(s). The file holds the bot token: keep it private.`, "ok");
}
async function importConfig(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.overshareConfig !== 1 || typeof data.botToken !== "string" || !/^\d+$/.test(String(data.channelId || ""))) throw new Error("not an OverShare configuration export");
    const pairs = tokensFromFile(data);
    // The same bot and channel already here just gets the file tokens added.
    const existing = configs.find((item) => item.token === data.botToken && item.channelId === String(data.channelId));
    const id = existing?.id || newConfigId();
    if (!existing) configs = [...configs, { id, name: uniqueConfigName(String(data.name || "").trim().slice(0, 40) || "Imported"), token: data.botToken, channelId: String(data.channelId), open: data.open === true }];
    await chrome.storage.local.set({ configs, ...tokenItems(id, pairs) });
    await selectConfig(id);
    setStatus(existing ? `Added ${pairs.length} file token(s) to ${config.name}, which has the same bot and channel.` : `Configuration ${config.name} imported with ${pairs.length} file token(s).`, "ok");
  } catch (error) { setStatus("Import failed: " + error.message, "err"); }
}
els.configDrop.addEventListener("click", () => els.importConfigFile.click());
els.importConfigFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (file) importConfig(file);
});
els.configDrop.addEventListener("dragover", (event) => { event.preventDefault(); els.configDrop.classList.add("drag"); });
els.configDrop.addEventListener("dragleave", () => els.configDrop.classList.remove("drag"));
els.configDrop.addEventListener("drop", (event) => {
  event.preventDefault(); els.configDrop.classList.remove("drag");
  const file = event.dataTransfer.files[0];
  if (file) importConfig(file);
});
async function deleteConfig(item) {
  if (busyWithConfig()) { setStatus("Wait for the running send, download or delete to finish.", "info"); return; }
  const data = await chrome.storage.local.get(null);
  const count = configTokens(data, item.id).length;
  if (!await askConfirm(`Delete the configuration ${item.name} and its ${count} file token(s) from this extension?\n\nIts files stay on Discord, but can't be downloaded without their tokens. Export the configuration first to keep them.`, { ok: "Delete", danger: true })) return;
  configs = configs.filter((other) => other.id !== item.id);
  if (editingId === item.id) openConfigForm(false);
  await chrome.storage.local.set({ configs });
  await chrome.storage.local.remove(Object.keys(data).filter((key) => key.startsWith(`${item.id}:`)));
  if (item.id === config.id) await selectConfig(configs[0]?.id || "");
  else renderConfigs();
  setStatus(`Configuration ${item.name} deleted.`, "ok");
}
const transferChannel = new BroadcastChannel("overshare");
transferChannel.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "uploadState") applyUploadState(message.send);
  else if (message.type === "downloadState") applyDownloadState(message.state);
  else if (message.type === "deleteState") applyDeleteState(message.state);
};
// The engine records each configuration's finished send as its lastFileToken, and clears it when that file is deleted.
chrome.storage.onChanged.addListener((changes, area) => {
  const change = area === "local" && config.id && changes[lastTokenKey(config.id)];
  if (change) lastSentToken = change.newValue || "";
});
(async () => {
  let data = await chrome.storage.local.get(null);
  if (!Array.isArray(data.configs)) { await migrateLegacyStorage(data); data = await chrome.storage.local.get(null); }
  configs = data.configs;
  config = configs.find((item) => item.id === data.activeConfigId) || configs[0] || NO_CONFIG;
  lastSentToken = data[lastTokenKey(config.id)] || "";
  renderConfigs();
  applyOpenMode();
  muted = !!data.muted; els.mute.textContent = muted ? "🔇" : "🔊";
  // Restore the stored upload before asking the engine, so its reply can confirm or clear it.
  if (data.activeUpload) activeUpload = { ...data.activeUpload, configId: data.activeUpload.config?.id, restored: true };
  refreshSendState();
  chrome.runtime.sendMessage({ target: "background", type: "ensureEngine" }).then(() => transferChannel.postMessage({ type: "hello" })).catch(() => {});
  checkBot();
  await restoreViewState();
})();
