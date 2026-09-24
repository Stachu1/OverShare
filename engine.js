"use strict";

// Transfer engine (offscreen.html). Runs sends, downloads and deletes so they
// keep going after the popup closes, and cleans up partial sends: on cancel, on
// error, and after a browser restart that interrupted one.

// Files are read and compressed this much at a time, so memory stays near one
// message of chunks no matter how big the transfer is.
const READ_SLICE_BYTES = 4 * 1024 * 1024;
// Compressed data is fed to the unzip in slices this small, which bounds how much
// a highly compressible file can expand before it is written out.
const UNZIP_SLICE_BYTES = 64 * 1024;
// Discord may still create a chunk message whose upload was aborted just as it
// finished, so cleanup searches the channel a second time after this delay.
const CLEANUP_RECHECK_MS = 3000;
const PUBLISH_INTERVAL_MS = 250;
// Encrypted chunks are held back and posted this many to a message, Discord's attachment limit.
const CHUNKS_PER_MESSAGE = 10;
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
	publish({ active: true, name: active.name, sent: active.sent, sending: active.sending, total: active.total, bytesSent: active.bytesSent, totalBytes: active.totalBytes, speed, eta, state: "sending", canceling: cancelRequested || active.cleaning, cleaning: active.cleaning, ...extra });
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

// Collects zip output and hands it back in exact chunk-sized pieces.
class ByteQueue {
	constructor() { this.parts = []; this.length = 0; }
	push(data) { if (data.length) { this.parts.push(data); this.length += data.length; } }
	take(count) {
		const out = new Uint8Array(count);
		let offset = 0;
		while (offset < count) {
			const part = this.parts[0], need = count - offset;
			if (part.length <= need) { out.set(part, offset); offset += part.length; this.parts.shift(); }
			else { out.set(part.subarray(0, need), offset); this.parts[0] = part.subarray(need); offset = count; }
		}
		this.length -= count;
		return out;
	}
}
// Zip timestamps can't go before 1980.
function zipTime(file) { return new Date(Math.max(file.lastModified || 0, Date.UTC(1980, 0, 2))); }

async function uploadFiles(job) {
	const { metadata, config, files } = job;
	const { sha, name, originalSize } = metadata;
	const record = { name, sha, symmetricKey: job.symmetricKey, total: null, config };
	active = { name, sent: 0, total: null, bytesSent: 0, totalBytes: originalSize, meter: new TransferMeter(originalSize), cleaning: false };
	abortController = new AbortController();
	const path = `/channels/${config.channelId}/messages`;
	try {
		// Stored first, so a browser restart mid-send can still find and remove the chunks.
		await storage("set", { activeUpload: record });
		publishActive();
		const key = await importChunkKey(job.symmetricKey, "encrypt");
		const prefix = crypto.getRandomValues(new Uint8Array(8));
		const queue = new ByteQueue();
		let zipError = null, zipDone = false;
		const zip = new fflate.Zip((error, data, final) => { if (error) zipError = error; else { queue.push(data); if (final) zipDone = true; } });
		let inputRead = 0, lastCutInput = 0, index = 0, encryptedSize = 0, firstId = null;
		let batch = []; // encrypted chunks waiting to go up in one message

		async function sendPiece(plain, final) {
			index++;
			const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(prefix, index), additionalData: chunkAad(sha, index, final) }, key, plain));
			encryptedSize += ciphertext.length;
			batch.push({ index, ciphertext });
			if (batch.length === CHUNKS_PER_MESSAGE || final) await sendBatch(final);
		}
		// Progress is counted in original bytes, spread over each message as it uploads.
		async function sendBatch(final) {
			const pieces = batch;
			batch = [];
			const from = lastCutInput, to = final ? originalSize : inputRead;
			lastCutInput = to;
			const form = new FormData();
			form.append("payload_json", JSON.stringify({}));
			let bytes = 0;
			pieces.forEach(({ index: number, ciphertext }, slot) => {
				form.append(`files[${slot}]`, new Blob([ciphertext]), `${sha}.${number}`);
				bytes += ciphertext.length;
			});
			active.sending = { from: pieces[0].index, to: pieces[pieces.length - 1].index };
			publishActive();
			const message = await discordUpload(config, path, form, {
				signal: abortController.signal,
				onProgress: (loaded) => {
					active.bytesSent = from + (to - from) * Math.min(1, loaded / bytes);
					if (performance.now() - lastPublish >= PUBLISH_INTERVAL_MS) publishActive();
				},
			});
			if (!firstId) firstId = message?.id;
			if (!firstId) throw new Error("Discord did not return the chunk message");
			active.sent = index;
			active.bytesSent = to;
			publishActive();
		}
		// Sends every full piece that can't be the last one; the last is sent after the zip ends.
		async function drain() {
			if (zipError) throw zipError;
			while (queue.length > PLAIN_CHUNK_BYTES) {
				throwIfCanceled();
				await sendPiece(queue.take(PLAIN_CHUNK_BYTES), false);
			}
		}

		for (const { file, path: filePath } of files) {
			const entry = new fflate.ZipDeflate(filePath, { level: 6, mtime: zipTime(file) });
			zip.add(entry);
			if (!file.size) entry.push(new Uint8Array(0), true);
			for (let offset = 0; offset < file.size; offset += READ_SLICE_BYTES) {
				throwIfCanceled();
				const slice = new Uint8Array(await file.slice(offset, offset + READ_SLICE_BYTES).arrayBuffer());
				inputRead += slice.length;
				entry.push(slice, offset + READ_SLICE_BYTES >= file.size);
				await drain();
			}
		}
		zip.end();
		await drain();
		if (!zipDone) throw new Error("the zip stream did not finish");
		throwIfCanceled();
		await sendPiece(queue.take(queue.length), true);
		throwIfCanceled();
		const manifest = { v: 3, sha, name, kind: metadata.kind, originalSize, encryptedSize, total: index, iv: base64urlEncode(prefix), firstId };
		await discordRequest(config, "POST", path, { json: { content: MANIFEST_MARKER + JSON.stringify(manifest) }, signal: abortController.signal });
		await storage("set", { [`${sha}.symmetricKey`]: job.symmetricKey, lastFileToken: `${sha}.${job.symmetricKey}` });
		await storage("remove", ["activeUpload"]);
		publish({ active: false, outcome: "ok", name, total: index });
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
async function saveBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	try { await background({ type: "download", url, filename, saveAs: true }); }
	finally { setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000); }
}
// Blob parts are kept by the browser outside this page's memory, and can go to disk.
function blobWriter(onClose) {
	const parts = [];
	return { write: async (data) => { parts.push(new Blob([data])); }, close: async () => onClose(new Blob(parts, { type: "application/octet-stream" })) };
}
async function folderWriter(dirHandle, path) {
	const segments = path.split("/").filter((segment) => segment && segment !== ".");
	const filename = segments.pop();
	let current = dirHandle;
	for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: true });
	const writable = await (await current.getFileHandle(filename, { create: true })).createWritable();
	return { write: (data) => writable.write(data), close: () => writable.close() };
}
// Streaming unzip whose file writes are async: push() waits until everything it
// produced has been written, so output never piles up in memory.
function unzipSink(openFile) {
	let chain = Promise.resolve(), failure = null;
	const unzip = new fflate.Unzip((file) => {
		if (file.name.endsWith("/")) { file.start(); return; }
		let target = null;
		chain = chain.then(async () => { target = await openFile(file.name); });
		file.ondata = (error, data, final) => {
			if (error) { failure = error; return; }
			chain = chain.then(() => target.write(data));
			if (final) chain = chain.then(() => target.close());
		};
		file.start();
	});
	unzip.register(fflate.UnzipInflate);
	return {
		async push(data, final) {
			for (let offset = 0; offset < data.length || (final && offset === 0); offset += UNZIP_SLICE_BYTES) {
				const last = final && offset + UNZIP_SLICE_BYTES >= data.length;
				unzip.push(data.subarray(offset, offset + UNZIP_SLICE_BYTES), last);
				if (failure) throw failure;
				await chain;
				if (last) break;
			}
		},
		done: () => chain,
	};
}

async function runDownload(job) {
	activeDownload = { sha: job.sha, name: job.name, phase: "downloading", done: 0, totalBytes: 0, meter: null };
	publishActiveDownload();
	try {
		const encodedKey = job.key.split(".", 2)[1];
		const item = await findTransfer(job.config, job.key);
		if (!item) throw new Error("file manifest not found");
		const onProgress = (done, totalBytes) => {
			activeDownload.meter ??= new TransferMeter(totalBytes);
			activeDownload.done = done; activeDownload.totalBytes = totalBytes;
			if (performance.now() - lastDownloadPublish >= PUBLISH_INTERVAL_MS) publishActiveDownload();
		};
		// The folder was picked in the popup; if its write access didn't carry over, save the zip instead.
		const canWriteFolder = job.dirHandle && await job.dirHandle.queryPermission({ mode: "readwrite" }).catch(() => "denied") === "granted";
		const zipName = job.name.replace(/\/$/, "") + ".zip";
		const note = job.dirHandle && !canWriteFolder ? " (saved as a zip: no write access to the chosen folder)" : "";
		const saves = [];

		// A folder is unzipped straight into place and a single file is unzipped
		// into a Blob; anything else is saved as the zip itself.
		let sink;
		if (canWriteFolder) sink = unzipSink((entryName) => folderWriter(job.dirHandle, entryName));
		else if (job.kind === "file") sink = unzipSink(async (entryName) => blobWriter((blob) => { saves.push(saveBlob(blob, entryName.split("/").pop())); }));
		else {
			const zipWriter = blobWriter((blob) => { saves.push(saveBlob(blob, zipName)); });
			sink = { push: async (data, final) => { await zipWriter.write(data); if (final) await zipWriter.close(); }, done: async () => {} };
		}
		const total = Number(item.manifest.total);
		let index = 0;
		for await (const plain of decryptChunks(item, encodedKey, onProgress)) {
			index++;
			await sink.push(plain, index === total);
		}
		activeDownload.phase = "saving"; publishActiveDownload();
		await sink.done();
		await Promise.all(saves);
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
		await uploadFiles(message.job);
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
