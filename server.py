"""Local OverShare bridge: receives encrypted bytes and posts them with a bot."""
import json
import hashlib
import os
import time
import base64

import requests
from flask import Flask, Response, request
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

app = Flask(__name__)
DISCORD_API = "https://discord.com/api/v10"
CHUNK_BYTES = 20 * 1024 * 1024


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


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/upload")
def upload():
    try:
        metadata = json.loads(request.headers.get("X-OverShare-Metadata", "{}"))
        target_channel = channel_id()
        sha = str(metadata["sha"])
        total = int(metadata["total"])
        body = request.get_data(cache=False)
        if hashlib.sha256(body).hexdigest() != sha:
            raise ValueError("encrypted payload SHA-256 does not match metadata")
        if total < 1 or total != (int(metadata["encryptedSize"]) + CHUNK_BYTES - 1) // CHUNK_BYTES:
            raise ValueError("invalid chunk metadata")
        if len(body) != int(metadata["encryptedSize"]):
            raise ValueError("encrypted payload size does not match metadata")
        manifest = {
            "sha": sha, "name": metadata["name"], "kind": metadata["kind"],
            "originalSize": metadata["originalSize"], "encryptedSize": len(body), "total": total,
        }
        content = f"OVERSHARE|{json.dumps(manifest, separators=(',', ':'))}"
        discord_post(target_channel, content)
        for index in range(total):
            chunk = body[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
            discord_post(target_channel, filename=f"{sha}.{index + 1}_{total}", data=chunk)
        return {"ok": True, "sha": sha, "total": total}
    except (KeyError, ValueError, json.JSONDecodeError) as error:
        return Response(str(error), status=400)
    except requests.HTTPError as error:
        return Response(f"Discord upload failed: {error}", status=502)
    except Exception as error:
        return Response(str(error), status=500)


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
