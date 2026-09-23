"use strict";

const LOCAL_SERVER = "http://localhost:7878";
const channel = new BroadcastChannel(ENGINE_CHANNEL);
let active = null;
let cancelRequested = false;

function publish(send) { channel.postMessage({ type: "uploadState", send }); }
function storage(operation, value) {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({ target: "background", type: "storage", operation, ...(operation === "set" ? { items: value } : { keys: value }) }, (response) => {
			if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
			if (!response?.ok) return reject(new Error(response?.error || "Storage operation failed"));
			resolve(response.result);
		});
	});
}
async function uploadBytes(job) {
	const response = await fetch(`${LOCAL_SERVER}/upload`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream", "X-OverShare-Metadata": JSON.stringify(job.metadata) },
		body: job.bytes,
	});
	if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
	const result = await response.json();
	active = { ...job, jobId: result.jobId, sent: 0, total: result.total };
	await storage("set", { activeUpload: { jobId: active.jobId, name: job.metadata.name, sha: job.metadata.sha, symmetricKey: job.symmetricKey, total: result.total } });
	for (;;) {
		if (cancelRequested) {
			await fetch(`${LOCAL_SERVER}/upload/cancel/${active.jobId}`, { method: "POST" });
			throw new DOMException("Upload canceled", "AbortError");
		}
		const statusResponse = await fetch(`${LOCAL_SERVER}/upload/status/${active.jobId}`);
		if (!statusResponse.ok) throw new Error(await statusResponse.text() || `HTTP ${statusResponse.status}`);
		const status = await statusResponse.json();
		active.sent = status.sent || 0;
		publish({ active: true, jobId: active.jobId, name: active.metadata.name, sent: active.sent, total: active.total, state: status.state });
		if (status.state === "complete") break;
		if (status.state === "canceled") throw new DOMException("Upload canceled", "AbortError");
		if (status.state === "error") throw new Error(status.error || "Upload failed");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	await storage("set", { [`${job.metadata.sha}.symmetricKey`]: job.symmetricKey, lastFileToken: `${job.metadata.sha}.${job.symmetricKey}` });
	await storage("remove", ["activeUpload"]);
	publish({ active: false, outcome: "ok", name: job.metadata.name, sent: active.total, total: active.total });
	active = null;
}

channel.onmessage = async (event) => {
	const message = event.data || {};
	if (message.type === "startUpload" && !active) {
		cancelRequested = false;
		try { await uploadBytes(message.job); }
		catch (error) {
			const canceled = error.name === "AbortError";
			await storage("remove", ["activeUpload"]);
			publish({ active: false, outcome: canceled ? "canceled" : "error", error: error.message });
			active = null;
		}
	} else if (message.type === "cancelUpload") {
		cancelRequested = true;
		publish({ active: true, canceling: true, jobId: active?.jobId });
	} else if (message.type === "hello") {
		if (active) publish({ active: true, jobId: active.jobId, name: active.metadata.name, sent: active.sent, total: active.total, state: "sending" });
	}
};
