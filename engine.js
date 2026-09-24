"use strict";

// Transfer engine (offscreen.html). Runs sends, downloads and deletes so they
// keep going after the popup closes, and cleans up partial sends: on cancel, on
// error, and after a browser restart that interrupted one.

const CHUNK_BYTES = 20 * 1024 * 1024;
// Discord may still create a chunk message whose upload was aborted just as it
// finished, so cleanup searches the channel a second time after this delay.
const CLEANUP_RECHECK_MS = 3000;
const PUBLISH_INTERVAL_MS = 250;
const channel = new BroadcastChannel(ENGINE_CHANNEL);

let active = null;          // the upload, or the cleanup of one
let cancelRequested = false;
let abortController = null;
let lastPublish = 0;
let activeDownload = null;
let lastDownloadPublish = 0;
let deleteJobs = [];        // queued and running deletes, run one at a time
let deleteQueue = Promise.resolve();

function background(message) {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({ target: "background", ...message }, (response) => {
			if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
			if (response?.error) return reject(new Error(response.error));
			resolve(response);
		});
	});
}
async function storage(operation, value) {
	const response = await background({ type: "storage", operation, ...(operation === "set" ? { items: value } : { keys: value }) });
	return response.result;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Uploads ----

function publish(send) { channel.postMessage({ type: "uploadState", send }); }
function publishActive(extra = {}) {
	lastPublish = performance.now();
	const { speed, eta } = active.meter.update(active.bytesSent);
	publish({ active: true, name: active.name, sent: active.sent, total: active.total, bytesSent: active.bytesSent, totalBytes: active.totalBytes, speed, eta, state: "sending", canceling: cancelRequested || active.cleaning, cleaning: active.cleaning, ...extra });
}
function throwIfCanceled() { if (cancelRequested) throw new DOMException("Upload canceled", "AbortError"); }

// Deletes everything a partial send left behind. If that fails, the file token is
// kept so the partial file shows in the Download list and can be deleted there.
async function cleanUpUpload(record) {
	try {
		await deleteTransfers(record.config, [record.sha]);
		await sleep(CLEANUP_RECHECK_MS);
		await deleteTransfers(record.config, [record.sha]);
		return null;
	} catch (error) {
		await storage("set", { [`${record.sha}.symmetricKey`]: record.symmetricKey }).catch(() => {});
		return error;
	}
}
function cleanupFailureText(error) { return `removing the sent chunks failed (${error.message}). The partial file is in the Download list; delete it there.`; }

async function uploadBytes(job) {
	const { metadata, config } = job;
	const bytes = new Uint8Array(job.bytes);
	const { sha, total } = metadata;
	const record = { name: metadata.name, sha, symmetricKey: job.symmetricKey, total, config };
	active = { name: metadata.name, sent: 0, total, bytesSent: 0, totalBytes: bytes.length, meter: new TransferMeter(bytes.length), cleaning: false };
	abortController = new AbortController();
	const path = `/channels/${config.channelId}/messages`;
	try {
		// Stored first, so a browser restart mid-send can still find and remove the chunks.
		await storage("set", { activeUpload: record });
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
					if (performance.now() - lastPublish >= PUBLISH_INTERVAL_MS) publishActive();
				},
			});
			active.sent = index + 1;
			active.bytesSent = before + chunk.length;
			publishActive();
		}
		throwIfCanceled();
		await storage("set", { [`${sha}.symmetricKey`]: job.symmetricKey, lastFileToken: `${sha}.${job.symmetricKey}` });
		await storage("remove", ["activeUpload"]);
		publish({ active: false, outcome: "ok", name: metadata.name, total });
	} catch (error) {
		const canceled = cancelRequested || error.name === "AbortError";
		active.cleaning = true;
		publishActive();
		const cleanupError = await cleanUpUpload(record);
		await storage("remove", ["activeUpload"]).catch(() => {});
		const lead = canceled ? "Upload canceled" : `Send failed: ${error.message}`;
		publish({
			active: false, outcome: canceled ? "canceled" : "error", failed: !canceled || !!cleanupError,
			text: cleanupError ? `${lead}, but ${cleanupFailureText(cleanupError)}` : `${lead}. Sent chunks were removed from Discord.`,
		});
	} finally {
		active = null;
		abortController = null;
	}
}

async function cleanUpInterruptedUpload(record) {
	const cleanupError = await cleanUpUpload(record);
	await storage("remove", ["activeUpload"]).catch(() => {});
	active = null;
	publish({
		active: false, outcome: "interrupted", failed: !!cleanupError,
		text: cleanupError ? `Upload of ${record.name} was interrupted, and ${cleanupFailureText(cleanupError)}` : `Upload of ${record.name} was interrupted; its sent chunks were removed. Send it again.`,
	});
}

// On startup, a stored activeUpload means the browser closed mid-send.
const ready = (async () => {
	const { activeUpload: record } = await storage("get", ["activeUpload"]);
	if (!record?.sha) return;
	if (!record.config) {
		const settings = await storage("get", ["botToken", "channelId"]);
		record.config = { token: settings.botToken, channelId: settings.channelId };
	}
	active = { name: record.name, sent: 0, total: record.total, bytesSent: 0, totalBytes: 0, meter: new TransferMeter(0), cleaning: true };
	cleanUpInterruptedUpload(record);
})().catch(() => {});

// ---- Downloads ----

function publishDownload(state) { channel.postMessage({ type: "downloadState", state }); }
function publishActiveDownload() {
	lastDownloadPublish = performance.now();
	const { speed, eta } = activeDownload.meter ? activeDownload.meter.update(activeDownload.done) : { speed: 0, eta: null };
	publishDownload({ active: true, sha: activeDownload.sha, name: activeDownload.name, phase: activeDownload.phase, done: activeDownload.done, totalBytes: activeDownload.totalBytes, speed, eta });
}
async function saveBytes(bytes, filename) {
	const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
	try { await background({ type: "download", url, filename, saveAs: true }); }
	finally { setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000); }
}
async function saveFolder(dirHandle, files) {
	for (const [path, bytes] of Object.entries(files)) {
		if (path.endsWith("/")) continue;
		const segments = path.split("/"); const filename = segments.pop(); let current = dirHandle;
		for (const segment of segments) if (segment) current = await current.getDirectoryHandle(segment, { create: true });
		const handle = await current.getFileHandle(filename, { create: true }); const writer = await handle.createWritable(); await writer.write(bytes); await writer.close();
	}
}

async function runDownload(job) {
	activeDownload = { sha: job.sha, name: job.name, phase: "downloading", done: 0, totalBytes: 0, meter: null };
	publishActiveDownload();
	try {
		const { zip } = await downloadTransfer(job.config, job.key, (done, totalBytes) => {
			activeDownload.meter ??= new TransferMeter(totalBytes);
			activeDownload.done = done; activeDownload.totalBytes = totalBytes;
			if (performance.now() - lastDownloadPublish >= PUBLISH_INTERVAL_MS) publishActiveDownload();
		});
		activeDownload.phase = "saving";
		publishActiveDownload();
		const entries = fflate.unzipSync(zip);
		const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
		let note = "";
		// The folder was picked in the popup; if its write access didn't carry over, save the zip instead.
		const canWriteFolder = job.dirHandle && await job.dirHandle.queryPermission({ mode: "readwrite" }).catch(() => "denied") === "granted";
		if (canWriteFolder) await saveFolder(job.dirHandle, entries);
		else if (job.kind === "file" && names.length === 1) await saveBytes(entries[names[0]], names[0].split("/").pop());
		else {
			await saveBytes(zip, job.name.replace(/\/$/, "") + ".zip");
			if (job.dirHandle) note = " (saved as a zip: no write access to the chosen folder)";
		}
		publishDownload({ active: false, outcome: "ok", sha: job.sha, text: `Downloaded ${job.name} ✓${note}` });
	} catch (error) {
		publishDownload({ active: false, outcome: "error", sha: job.sha, text: `Download failed: ${error.message}` });
	} finally {
		activeDownload = null;
	}
}

// ---- Deletes ----

function pendingDeleteShas() { return deleteJobs.flatMap((job) => job.shas); }
function publishDeletes(finished = null) {
	const current = deleteJobs[0];
	channel.postMessage({ type: "deleteState", state: { pendingShas: pendingDeleteShas(), current: current ? { label: current.label, deleted: current.deleted } : null, finished } });
}
async function removeTokens(shas) {
	const data = await storage("get", null);
	const wanted = new Set(shas);
	const matches = (token) => typeof token === "string" && wanted.has(token.split(".", 1)[0]);
	const removals = Object.keys(data).filter((name) =>
		(name.endsWith(".symmetricKey") && wanted.has(name.slice(0, -13)))
		|| ((name === "lastFileToken" || name === "lastKey") && matches(data[name])));
	if (removals.length) await storage("remove", removals);
}
async function runDelete(job) {
	publishDeletes();
	let finished;
	try {
		const deleted = await deleteTransfers(job.config, job.shas, (count) => { job.deleted = count; publishDeletes(); });
		// Tokens go only after Discord is clean, so an interrupted delete can be retried.
		await removeTokens(job.shas);
		finished = { outcome: "ok", shas: job.shas, text: `Deleted ${job.label}: ${deleted} Discord message(s) removed.` };
	} catch (error) {
		finished = { outcome: "error", shas: job.shas, text: `Delete failed: ${error.message}` };
	}
	deleteJobs.shift();
	publishDeletes(finished);
}
function enqueueDelete(job) {
	deleteJobs.push({ ...job, deleted: 0 });
	const queued = deleteJobs[deleteJobs.length - 1];
	deleteQueue = deleteQueue.then(() => runDelete(queued));
	publishDeletes();
}

// ---- Messages from the popup ----

channel.onmessage = async (event) => {
	const message = event.data || {};
	// Answer only once any interrupted upload has been picked up, so the popup never sees a stale idle.
	await ready;
	if (message.type === "startUpload") {
		if (active) {
			publish({ active: false, outcome: "error", failed: true, text: "Another upload is still running." });
			publishActive();
			return;
		}
		cancelRequested = false;
		await uploadBytes(message.job);
	} else if (message.type === "cancelUpload") {
		if (!active || active.cleaning) return;
		cancelRequested = true;
		abortController?.abort();
		publishActive();
	} else if (message.type === "startDownload") {
		if (activeDownload) { publishDownload({ active: false, outcome: "error", sha: message.job.sha, text: "Another download is still running." }); publishActiveDownload(); return; }
		await runDownload(message.job);
	} else if (message.type === "startDelete") {
		enqueueDelete(message.job);
	} else if (message.type === "hello") {
		if (active) publishActive();
		else publish({ active: false, idle: true });
		if (activeDownload) publishActiveDownload();
		if (deleteJobs.length) publishDeletes();
	}
};
