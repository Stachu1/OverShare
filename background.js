"use strict";

// Service worker. Keeps the transfer engine (offscreen.html) alive so sends and
// downloads survive the popup closing, and makes the chrome.* calls the engine
// can't (offscreen documents only get chrome.runtime).

const OFFSCREEN_URL = "offscreen.html";
let creating = null;

async function ensureEngine() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Run file uploads/downloads so they continue after the popup closes.",
    }).finally(() => { creating = null; });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;
  if (msg.type === "ensureEngine") {
    ensureEngine().then(() => sendResponse({ ok: true }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "download") {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: msg.saveAs })
      .then((id) => sendResponse({ id }), (e) => sendResponse({ error: e.message }));
    return true;
  }
});
