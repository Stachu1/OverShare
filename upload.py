"""Send a file to Discord the way the OverShare extension does, from the command line.

    BOT_TOKEN=... CHANNEL_ID=... python upload.py file.mp4

The file is zipped, cut into 20 MB pieces, encrypted with AES-256-GCM and uploaded
through the bot, then a manifest is posted, all in the same format as the
extension, so the file shows up in its Download list. The file token
("<id>.<key>") is printed and added to overshare-tokens.json next to this script,
which the extension's Import Tokens button reads.

Needs: pip install requests cryptography
"""

import base64
import json
import os
import secrets
import struct
import sys
import time
import zipfile
from pathlib import Path

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# These match shared.js and engine.js.
API = "https://discord.com/api/v10"
USER_AGENT = "DiscordBot (overshare, 3.0)"  # Discord rejects bot requests with other agents
MANIFEST_MARKER = "OVERSHARE|"
CHUNK_BYTES = 20 * 1024 * 1024
PLAIN_CHUNK_BYTES = CHUNK_BYTES - 16  # AES-GCM adds a 16-byte tag
READ_SLICE_BYTES = 4 * 1024 * 1024
ID_BYTES = 8
# After a gateway timeout or dropped connection Discord may still have kept the
# message, so the channel is checked for it before sending again.
SEND_ATTEMPTS = 4
SEND_RECHECK_SECONDS = 3
TOKENS_FILE = Path(__file__).resolve().parent / "overshare-tokens.json"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def chunk_iv(prefix, index):
    return prefix + struct.pack(">I", index)


def chunk_aad(sha, index, final):
    return f"OVERSHARE2|{sha}|{index}|{1 if final else 0}".encode()


def js_json(value):
    """JSON the way JavaScript's JSON.stringify writes it, since the manifest tag covers it."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def manifest_tag(manifest, cipher):
    aad = js_json(["OVERSHARE-MANIFEST", manifest["sha"], manifest["name"], manifest["kind"],
                   manifest["originalSize"], manifest["encryptedSize"], manifest["total"]]).encode()
    prefix = base64.urlsafe_b64decode(manifest["iv"] + "=" * (-len(manifest["iv"]) % 4))
    return b64url(cipher.encrypt(chunk_iv(prefix, 0), b"", aad))


class UncertainFailure(Exception):
    """The request may or may not have reached Discord."""


class Discord:
    def __init__(self, token, channel_id):
        self.path = f"{API}/channels/{channel_id}/messages"
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bot {token}", "User-Agent": USER_AGENT})

    def request(self, method, url, **kwargs):
        while True:
            try:
                response = self.session.request(method, url, timeout=300, **kwargs)
            except (requests.ConnectionError, requests.Timeout) as error:
                raise UncertainFailure(str(error)) from error
            if response.status_code == 429:
                time.sleep(float(response.json().get("retry_after", 1)))
                continue
            if method == "DELETE" and response.status_code == 404:
                return None
            if response.status_code in (502, 503, 504):
                raise UncertainFailure(f"Discord {response.status_code}")
            if not response.ok:
                try:
                    data = response.json()
                except ValueError:
                    data = {}
                raise RuntimeError(f"Discord {response.status_code}: {data.get('message', response.reason)}")
            return None if response.status_code == 204 else response.json()

    def latest_messages(self):
        return self.request("GET", self.path, params={"limit": 100})

    def send_chunk(self, filename, data):
        files = {"files[0]": (filename, data, "application/octet-stream")}
        return self.request("POST", self.path, data={"payload_json": "{}"}, files=files)

    def send_message(self, content):
        return self.request("POST", self.path, json={"content": content})

    def delete(self, message_id):
        self.request("DELETE", f"{self.path}/{message_id}")


def send_checked(discord, what, send, is_sent):
    for attempt in range(1, SEND_ATTEMPTS + 1):
        try:
            return send()
        except UncertainFailure as error:
            time.sleep(SEND_RECHECK_SECONDS * attempt)
            found = next((m for m in discord.latest_messages() if is_sent(m)), None)
            if found:
                return found
            if attempt == SEND_ATTEMPTS:
                raise RuntimeError(f"{what} could not be sent after {SEND_ATTEMPTS} attempts ({error})") from error
            print(f"\n{what} failed ({error}), sending again ({attempt + 1}/{SEND_ATTEMPTS})", file=sys.stderr)


def human_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


class Buffer:
    """Where the zip is written; send() empties it a chunk at a time."""

    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data += data
        return len(data)

    def flush(self):
        pass


def upload_file(path, discord):
    """Sends one file and returns its file token."""
    path = Path(path)
    size = path.stat().st_size
    sha = secrets.token_hex(ID_BYTES)
    key = secrets.token_bytes(32)
    cipher = AESGCM(key)
    prefix = secrets.token_bytes(8)
    sent_ids = []
    state = {"index": 0, "encrypted": 0, "read": 0}
    started = time.monotonic()

    def send_piece(plain, final):
        state["index"] += 1
        index = state["index"]
        ciphertext = cipher.encrypt(chunk_iv(prefix, index), bytes(plain), chunk_aad(sha, index, final))
        state["encrypted"] += len(ciphertext)
        filename = f"{sha}.{index}"
        message = send_checked(discord, f"chunk {index}", lambda: discord.send_chunk(filename, ciphertext),
                               lambda m: any(a.get("filename") == filename and a.get("size") in (None, len(ciphertext))
                                             for a in m.get("attachments") or []))
        sent_ids.append(message["id"])
        elapsed = time.monotonic() - started
        done = size if final else state["read"]
        print(f"\rchunk {index} sent · {human_size(done)} / {human_size(size)} · {human_size(done / elapsed if elapsed else 0)}/s   ",
              end="", file=sys.stderr, flush=True)

    def drain(buffer):
        # The last piece is only known once the zip ends, so a piece that could be it is held back.
        while len(buffer.data) > PLAIN_CHUNK_BYTES:
            piece = buffer.data[:PLAIN_CHUNK_BYTES]
            del buffer.data[:PLAIN_CHUNK_BYTES]
            send_piece(piece, False)

    try:
        buffer = Buffer()
        # The buffer can't seek, so the zip is streamed with data descriptors, as the extension's zip is.
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            mtime = time.localtime(max(path.stat().st_mtime, 315705600))  # zip dates start in 1980
            info = zipfile.ZipInfo(path.name, date_time=mtime[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.file_size = size  # decides whether the entry needs zip64
            with path.open("rb") as source, archive.open(info, "w") as entry:
                while slice_ := source.read(READ_SLICE_BYTES):
                    state["read"] += len(slice_)
                    entry.write(slice_)
                    drain(buffer)
        drain(buffer)
        send_piece(buffer.data, True)

        manifest = {"v": 3, "sha": sha, "name": path.name, "kind": "file", "originalSize": size,
                    "encryptedSize": state["encrypted"], "total": state["index"], "iv": b64url(prefix), "firstId": sent_ids[0]}
        manifest["tag"] = manifest_tag(manifest, cipher)
        content = MANIFEST_MARKER + js_json(manifest)
        send_checked(discord, "the file manifest", lambda: discord.send_message(content), lambda m: m.get("content") == content)
    except BaseException:
        print(f"\nSend failed; removing {len(sent_ids)} sent chunk(s) from Discord.", file=sys.stderr)
        for message_id in sent_ids:
            try:
                discord.delete(message_id)
            except Exception as error:
                print(f"Could not delete message {message_id}: {error}", file=sys.stderr)
        raise
    print(file=sys.stderr)
    return f"{sha}.{b64url(key)}"


def save_token(token):
    """Adds the token to the tokens file, in the extension's export format."""
    sha, key = token.split(".")
    try:
        tokens = json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        tokens = {}
    tokens[f"{sha}.symmetricKey"] = key
    TOKENS_FILE.write_text(json.dumps(tokens, indent=2) + "\n", encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: python upload.py <file>")
    token, channel_id = os.environ.get("BOT_TOKEN"), os.environ.get("CHANNEL_ID")
    if not token or not channel_id:
        sys.exit("Set the BOT_TOKEN and CHANNEL_ID environment variables.")
    path = Path(sys.argv[1])
    if not path.is_file():
        sys.exit(f"{path} is not a file.")
    try:
        file_token = upload_file(path, Discord(token, channel_id))
    except KeyboardInterrupt:
        sys.exit("Upload canceled.")
    except Exception as error:
        sys.exit(f"Send failed: {error}")
    save_token(file_token)
    print(file_token)
    print(f"Sent {path.name}. Token saved to {TOKENS_FILE.name}.", file=sys.stderr)


if __name__ == "__main__":
    main()
