"use strict";

// Helpers shared by the popup (popup.js) and the transfer engine (engine.js).

const API = "https://discord.com/api/v10";
const MANIFEST_MARKER = "OVERSHARE|";
// Popup <-> engine messages. A BroadcastChannel (unlike chrome.runtime
// messaging) can carry Blobs and directory handles.
const ENGINE_CHANNEL = "overshare";

function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
