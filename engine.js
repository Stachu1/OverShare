"use strict";

const CHUNK_BYTES = 20 * 1024 * 1024;
const channel = new BroadcastChannel(ENGINE_CHANNEL);
let active = null;
let cancelRequested = false;
let abortController = null;
let lastPublish = 0;

function publish(send) { channel.postMessage({ type: "uploadState", send }); }
function publishActive(extra = {}) {
	lastPublish = performance.now();
	const { speed, eta } = active.meter.update(active.bytesSent);
	publish({ active: true, name: active.metadata.name, sent: active.sent, total: active.total, bytesSent: active.bytesSent, totalBytes: active.totalBytes, speed, eta, state: "sending", ...extra });
}
function storage(operation, value) {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({ target: "background", type: "storage", operation, ...(operation === "set" ? { items: value } : { keys: value }) }, (response) => {
			if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
			if (!response?.ok) return reject(new Error(response?.error || "Storage operation failed"));
			resolve(response.result);
		});
	});
}
function throwIfCanceled() { if (cancelRequested) throw new DOMException("Upload canceled", "AbortError"); }

async function uploadBytes(job) {
	const { metadata, config } = job;
	const bytes = new Uint8Array(job.bytes);
	const { sha, total } = metadata;
	active = { ...job, sent: 0, total, bytesSent: 0, totalBytes: bytes.length, meter: new TransferMeter(bytes.length) };
	abortController = new AbortController();
	const path = `/channels/${config.channelId}/messages`;
	await storage("set", { activeUpload: { name: metadata.name, sha, symmetricKey: job.symmetricKey, total } });
	publishActive();
	const manifest = { sha, name: metadata.name, kind: metadata.kind, originalSize: metadata.originalSize, encryptedSize: bytes.length, total };
	await discordRequest(config, "POST", path, { json: { content: MANIFEST_MARKER + JSON.stringify(manifest) }, signal: abortController.signal });
	for (let index = 0; index < total; index++) {
		throwIfCanceled();
		const chunk = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
		const form = new FormData();
		form.append("payload_json", JSON.stringify({}));
		form.append("files[0]", new Blob([chunk]), `${sha}.${index + 1}_${total}`);
		const before = index * CHUNK_BYTES;
		await discordUpload(config, path, form, {
			signal: abortController.signal,
			onProgress: (loaded) => {
				// loaded includes the multipart framing, so cap it at the chunk size.
				active.bytesSent = before + Math.min(loaded, chunk.length);
				if (performance.now() - lastPublish >= 250) publishActive();
			},
		});
		active.sent = index + 1;
		active.bytesSent = before + chunk.length;
		publishActive();
	}
	throwIfCanceled();
	await storage("set", { [`${sha}.symmetricKey`]: job.symmetricKey, lastFileToken: `${sha}.${job.symmetricKey}` });
	await storage("remove", ["activeUpload"]);
	publish({ active: false, outcome: "ok", name: metadata.name, sent: total, total });
	active = null;
}

channel.onmessage = async (event) => {
	const message = event.data || {};
	if (message.type === "startUpload" && !active) {
		cancelRequested = false;
		try { await uploadBytes(message.job); }
		catch (error) {
			const canceled = cancelRequested || error.name === "AbortError";
			let text = canceled ? "Upload canceled" : error.message;
			if (canceled) {
				try { await deleteTransfers(message.job.config, [message.job.metadata.sha]); }
				catch (cleanupError) { text += `; cleanup failed: ${cleanupError.message}`; }
			}
			await storage("remove", ["activeUpload"]).catch(() => {});
			publish({ active: false, outcome: canceled ? "canceled" : "error", error: text });
			active = null;
		}
	} else if (message.type === "cancelUpload") {
		if (!active) return;
		cancelRequested = true;
		abortController?.abort();
		publishActive({ canceling: true });
	} else if (message.type === "hello") {
		if (active) publishActive(cancelRequested ? { canceling: true } : {});
		else publish({ active: false, idle: true });
	}
};
