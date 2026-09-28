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

// A stored activeUpload after a restart means a send was interrupted; start the
// engine so it removes the sent chunks without waiting for the popup.
chrome.runtime.onStartup.addListener(async () => {
  const { activeUpload } = await chrome.storage.local.get("activeUpload");
  if (activeUpload) ensureEngine().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "background") return;
  if (message.type === "ensureEngine") {
    ensureEngine().then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "download") {
    chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: message.saveAs })
      .then((id) => sendResponse({ id }), (error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === "storage") {
    const operation = message.operation === "get"
      ? chrome.storage.local.get(message.keys)
      : message.operation === "set"
        ? chrome.storage.local.set(message.items)
        : message.operation === "remove"
          ? chrome.storage.local.remove(message.keys)
          : Promise.reject(new Error("Unknown storage operation"));
    operation.then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ error: error.message }));
    return true;
  }
});
