"""Local OverShare bridge: receives encrypted bytes and posts them with a bot."""
import json
import hashlib
import os
import time
import base64
import threading
import uuid

import requests
from flask import Flask, Response, request
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

app = Flask(__name__)
DISCORD_API = "https://discord.com/api/v10"
CHUNK_BYTES = 20 * 1024 * 1024
UPLOAD_JOBS = {}
UPLOAD_JOBS_LOCK = threading.Lock()


@app.after_request
def allow_extension_requests(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-OverShare-Metadata"
    return response


def discord_post(channel_id, content="", filename=None, data=None):
    token = os.environ.get("OVERSHARE_DISCORD_BOT_TOKEN")
    if not token:
        raise RuntimeError("OVERSHARE_DISCORD_BOT_TOKEN is not set")
    files = {"file": (filename, data, "application/octet-stream")} if filename else None
    response = requests.post(
        f"{DISCORD_API}/channels/{channel_id}/messages",
        headers={"Authorization": f"Bot {token}"},
        data={"payload_json": json.dumps({"content": content})},
        files=files,
        timeout=180,
    )
    if response.status_code == 429:
        time.sleep(float(response.json().get("retry_after", 1)))
        return discord_post(channel_id, content, filename, data)
    response.raise_for_status()


def discord_get(path, **params):
    token = os.environ.get("OVERSHARE_DISCORD_BOT_TOKEN")
    if not token:
        raise RuntimeError("OVERSHARE_DISCORD_BOT_TOKEN is not set")
    while True:
        response = requests.get(
            f"{DISCORD_API}{path}",
            headers={"Authorization": f"Bot {token}"},
            params=params,
            timeout=60,
        )
        if response.status_code == 429:
            time.sleep(float(response.json().get("retry_after", 1)))
            continue
        response.raise_for_status()
        return response.json()


def discord_delete(path):
    token = os.environ.get("OVERSHARE_DISCORD_BOT_TOKEN")
    if not token:
        raise RuntimeError("OVERSHARE_DISCORD_BOT_TOKEN is not set")
    while True:
        response = requests.delete(f"{DISCORD_API}{path}", headers={"Authorization": f"Bot {token}"}, timeout=60)
        if response.status_code == 429:
            time.sleep(float(response.json().get("retry_after", 1)))
            continue
        if response.status_code == 404:
            return
        response.raise_for_status()


def channel_id():
    value = os.environ.get("OVERSHARE_DISCORD_CHANNEL_ID")
    if not value:
        raise RuntimeError("OVERSHARE_DISCORD_CHANNEL_ID is not set")
    return value


def manifests_for_keys(keys):
    wanted = {key.split(".", 1)[0] for key in keys if "." in key}
    messages = []
    before = None
    for _ in range(100):
        params = {"limit": 100}
        if before:
            params["before"] = before
        page = discord_get(f"/channels/{channel_id()}/messages", **params)
        messages.extend(page)
        if len(page) < 100:
            break
        before = page[-1].get("id")
        if not before:
            break
    found = {}
    parts_by_sha = {}
    for message in messages:
        content = message.get("content", "")
        if content.startswith("OVERSHARE|"):
            try:
                manifest = json.loads(content.split("\n", 1)[0][len("OVERSHARE|"):])
            except (ValueError, TypeError):
                manifest = None
            if manifest:
                sha = manifest.get("sha")
                if sha in wanted:
                    found.setdefault(sha, {"manifest": manifest, "parts": {}})
        for attachment in message.get("attachments", []):
            name = attachment.get("filename", "")
            if "." not in name:
                continue
            base, suffix = name.rsplit(".", 1)
            if base not in wanted or "_" not in suffix:
                continue
            index, total = suffix.split("_", 1)
            if index.isdigit() and total.isdigit() and base in wanted:
                parts_by_sha.setdefault(base, {})[int(index)] = {"url": attachment["url"], "size": attachment.get("size", 0)}
    result = []
    for sha in sorted(wanted):
        item = found.get(sha)
        if not item:
            result.append({"sha": sha, "name": "Unknown transfer", "available": False, "manifestFound": False, "missingFile": True, "missingChunks": None})
            continue
        manifest = item["manifest"]
        item["parts"] = parts_by_sha.get(sha, {})
        total = int(manifest["total"])
        have = sum(index in item["parts"] for index in range(1, total + 1))
        missing = total - have
        result.append({**manifest, "available": missing == 0, "manifestFound": True, "missingFile": False, "missingChunks": missing})
    return result, found


def delete_messages_for_shas(wanted):
    messages = []
    before = None
    for _ in range(100):
        params = {"limit": 100}
        if before:
            params["before"] = before
        page = discord_get(f"/channels/{channel_id()}/messages", **params)
        messages.extend(page)
        if len(page) < 100:
            break
        before = page[-1].get("id")
        if not before:
            break
    deleted = 0
    for message in messages:
        matches = any(sha in message.get("content", "") for sha in wanted)
        matches = matches or any(
            attachment.get("filename", "").rsplit(".", 1)[0] in wanted
            for attachment in message.get("attachments", [])
            if "." in attachment.get("filename", "")
        )
        if matches:
            discord_delete(f"/channels/{channel_id()}/messages/{message['id']}")
            deleted += 1
    return deleted


@app.get("/health")
def health():
    return {"ok": True}


def run_upload(job_id, metadata, body):
    try:
        target_channel = channel_id()
        sha = str(metadata["sha"])
        total = int(metadata["total"])
        manifest = {"sha": sha, "name": metadata["name"], "kind": metadata["kind"], "originalSize": metadata["originalSize"], "encryptedSize": len(body), "total": total}
        discord_post(target_channel, f"OVERSHARE|{json.dumps(manifest, separators=(',', ':'))}")
        with UPLOAD_JOBS_LOCK:
            if UPLOAD_JOBS[job_id].get("cancel_requested"):
                raise RuntimeError("Upload canceled")
        for index in range(total):
            chunk = body[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
            discord_post(target_channel, filename=f"{sha}.{index + 1}_{total}", data=chunk)
            with UPLOAD_JOBS_LOCK:
                UPLOAD_JOBS[job_id]["sent"] = index + 1
                canceled = UPLOAD_JOBS[job_id].get("cancel_requested")
            if canceled:
                raise RuntimeError("Upload canceled")
        with UPLOAD_JOBS_LOCK:
            UPLOAD_JOBS[job_id]["state"] = "complete"
    except Exception as error:
        canceled = "Upload canceled" in str(error)
        if canceled:
            try:
                delete_messages_for_shas({str(metadata.get("sha"))})
            except Exception as cleanup_error:
                error = RuntimeError(f"{error}; cleanup failed: {cleanup_error}")
        with UPLOAD_JOBS_LOCK:
            UPLOAD_JOBS[job_id]["state"] = "canceled" if canceled else "error"
            UPLOAD_JOBS[job_id]["error"] = str(error)


@app.post("/upload")
def upload():
    try:
        metadata = json.loads(request.headers.get("X-OverShare-Metadata", "{}"))
        sha = str(metadata["sha"])
        body = request.get_data(cache=False)
        total = int(metadata["total"])
        if hashlib.sha256(body).hexdigest() != sha:
            raise ValueError("encrypted payload SHA-256 does not match metadata")
        if total < 1 or total != (int(metadata["encryptedSize"]) + CHUNK_BYTES - 1) // CHUNK_BYTES:
            raise ValueError("invalid chunk metadata")
        if len(body) != int(metadata["encryptedSize"]):
            raise ValueError("encrypted payload size does not match metadata")
        job_id = uuid.uuid4().hex
        with UPLOAD_JOBS_LOCK:
            UPLOAD_JOBS[job_id] = {"state": "sending", "sent": 0, "total": total}
        threading.Thread(target=run_upload, args=(job_id, metadata, body), daemon=True).start()
        return {"jobId": job_id, "sha": sha, "total": total}, 202
    except (KeyError, ValueError, json.JSONDecodeError) as error:
        return Response(str(error), status=400)
    except requests.HTTPError as error:
        return Response(f"Discord upload failed: {error}", status=502)
    except Exception as error:
        return Response(str(error), status=500)


@app.get("/upload/status/<job_id>")
def upload_status(job_id):
    with UPLOAD_JOBS_LOCK:
        job = UPLOAD_JOBS.get(job_id)
    if not job:
        return Response("upload job not found", status=404)
    return job


@app.post("/upload/cancel/<job_id>")
def cancel_upload(job_id):
    with UPLOAD_JOBS_LOCK:
        job = UPLOAD_JOBS.get(job_id)
        if not job:
            return Response("upload job not found", status=404)
        if job["state"] != "sending":
            return {"state": job["state"]}
        job["cancel_requested"] = True
    return {"state": "canceling"}


@app.route("/files", methods=["OPTIONS"])
def files_options():
    return "", 204


@app.post("/files")
def files():
    try:
        keys = request.get_json(force=True).get("keys", [])
        available, _ = manifests_for_keys(keys)
        return {"files": available}
    except Exception as error:
        return Response(str(error), status=500)


@app.route("/delete", methods=["OPTIONS"])
def delete_options():
    return "", 204


@app.post("/delete")
def delete_files():
    try:
        keys = request.get_json(force=True).get("keys", [])
        wanted = {key.split(".", 1)[0] for key in keys if "." in key}
        if not wanted:
            return {"deleted": 0}
        messages = []
        before = None
        for _ in range(100):
            params = {"limit": 100}
            if before:
                params["before"] = before
            page = discord_get(f"/channels/{channel_id()}/messages", **params)
            messages.extend(page)
            if len(page) < 100:
                break
            before = page[-1].get("id")
            if not before:
                break
        deleted = 0
        for message in messages:
            matches = any(sha in message.get("content", "") for sha in wanted)
            matches = matches or any(
                attachment.get("filename", "").rsplit(".", 1)[0] in wanted
                for attachment in message.get("attachments", [])
                if "." in attachment.get("filename", "")
            )
            if matches:
                discord_delete(f"/channels/{channel_id()}/messages/{message['id']}")
                deleted += 1
        return {"deleted": deleted}
    except Exception as error:
        return Response(str(error), status=500)


@app.route("/download", methods=["OPTIONS"])
def download_options():
    return "", 204


@app.post("/download")
def download():
    try:
        key = request.get_json(force=True).get("key", "")
        if "." not in key:
            raise ValueError("invalid recovery key")
        sha, encoded_key = key.split(".", 1)
        _, found = manifests_for_keys([key])
        item = found.get(sha)
        if not item:
            return Response("file manifest not found", status=404)
        manifest = item["manifest"]
        total = int(manifest["total"])
        if len(item["parts"]) != total or not all(i in item["parts"] for i in range(1, total + 1)):
            return Response("not all chunks are available", status=409)
        chunks = []
        for i in range(1, total + 1):
            chunk_response = requests.get(item["parts"][i]["url"], timeout=180)
            chunk_response.raise_for_status()
            chunks.append(chunk_response.content)
        encrypted = b"".join(chunks)
        if hashlib.sha256(encrypted).hexdigest() != sha:
            raise ValueError("encrypted payload SHA-256 does not match manifest")
        raw_key = base64.urlsafe_b64decode(encoded_key + "=" * (-len(encoded_key) % 4))
        decrypted_zip = AESGCM(raw_key).decrypt(encrypted[:12], encrypted[12:], None)
        response = Response(decrypted_zip, mimetype="application/zip")
        response.headers["X-OverShare-Name"] = manifest["name"]
        response.headers["X-OverShare-Kind"] = manifest["kind"]
        return response
    except (KeyError, ValueError, TypeError) as error:
        return Response(str(error), status=400)
    except Exception as error:
        return Response(str(error), status=500)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7878)
