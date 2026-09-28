"""Delete every message in a Discord channel, after showing what is in it.

    python clear_channel.py

Asks for the bot token and channel ID, reads the channel's whole history and
lists the OverShare files in it (names are shown when the file is in an open
channel or its token is in overshare-tokens.json), unfinished uploads, other
messages and how much data they hold. Nothing is deleted until you confirm.

Needs: pip install requests cryptography
"""

import getpass
import json
import sys
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from upload import (MANIFEST_MARKER, OPEN_MASTER_KEY, TOKENS_FILE, Discord, b64url_decode,
                    chunk_iv, human_size)

DISCORD_EPOCH_MS = 1420070400000
# Bulk delete takes 2 to 100 messages, none older than two weeks.
BULK_MAX = 100
BULK_AGE_MS = 14 * 24 * 3600 * 1000 - 60 * 60 * 1000  # an hour of margin


def all_messages(discord):
    messages, before = [], None
    while True:
        params = {"limit": 100, **({"before": before} if before else {})}
        page = discord.request("GET", discord.path, params=params)
        messages += page
        print(f"\rReading the channel… {len(messages)} messages", end="", file=sys.stderr, flush=True)
        if len(page) < 100:
            break
        before = page[-1]["id"]
    print(file=sys.stderr)
    return messages


def known_keys():
    """sha -> key from overshare-tokens.json (the extension's export format)."""
    try:
        data = json.loads(TOKENS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return {}
    suffix = ".symmetricKey"
    return {name[:-len(suffix)].rsplit(":", 1)[-1]: value for name, value in data.items()
            if name.endswith(suffix) and isinstance(value, str)}


def file_name(manifest, keys):
    if manifest.get("v") == 3:
        return manifest.get("name") or "?"
    for key in (keys.get(manifest.get("sha")), OPEN_MASTER_KEY):
        if not key:
            continue
        try:
            iv = chunk_iv(b64url_decode(manifest["iv"]), 0)
            return AESGCM(b64url_decode(key)).decrypt(iv, b64url_decode(manifest["title"]), None).decode()
        except Exception:
            pass
    return "(encrypted name, no token)"


def summarize(messages):
    keys = known_keys()
    files, chunks, others = {}, {}, 0  # sha -> manifest, sha -> [count, bytes]
    total_bytes = 0
    for message in messages:
        attachments = message.get("attachments") or []
        content = message.get("content") or ""
        is_overshare = False
        if content.startswith(MANIFEST_MARKER):
            try:
                manifest = json.loads(content.split("\n", 1)[0][len(MANIFEST_MARKER):])
                files[manifest["sha"]] = manifest
                is_overshare = True
            except (ValueError, KeyError, TypeError):
                pass
        for attachment in attachments:
            size = attachment.get("size") or 0
            total_bytes += size
            sha, _, number = (attachment.get("filename") or "").rpartition(".")
            if sha and number.isdigit():
                entry = chunks.setdefault(sha, [0, 0])
                entry[0] += 1
                entry[1] += size
                is_overshare = True
        if not is_overshare:
            others += 1

    print(f"{len(messages)} messages holding {human_size(total_bytes)} of attachments.")
    if files:
        print(f"\nFiles ({len(files)}):")
        for sha, manifest in files.items():
            count, size = chunks.get(sha, [0, 0])
            missing = f", {int(manifest.get('total', 0)) - count} chunk(s) missing" if count < int(manifest.get("total", 0)) else ""
            print(f"  {file_name(manifest, keys)} · {human_size(int(manifest.get('originalSize', 0)))}"
                  f" · {count} chunk(s), {human_size(size)} on Discord{missing}")
    unfinished = {sha: entry for sha, entry in chunks.items() if sha not in files}
    if unfinished:
        count = sum(entry[0] for entry in unfinished.values())
        size = sum(entry[1] for entry in unfinished.values())
        print(f"\nUnfinished uploads: {len(unfinished)} ({count} chunk(s), {human_size(size)})")
    if others:
        print(f"\nOther messages: {others}")


def snowflake_ms(message_id):
    return (int(message_id) >> 22) + DISCORD_EPOCH_MS


def delete_all(discord, messages):
    now_ms = time.time() * 1000
    recent = [m["id"] for m in messages if now_ms - snowflake_ms(m["id"]) < BULK_AGE_MS]
    old = [m["id"] for m in messages if now_ms - snowflake_ms(m["id"]) >= BULK_AGE_MS]
    deleted = 0

    def progress():
        print(f"\rDeleted {deleted} / {len(messages)}", end="", file=sys.stderr, flush=True)

    # Bulk delete needs the Manage Messages permission; without it every message goes one at a time.
    while len(recent) >= 2:
        group, recent = recent[:BULK_MAX], recent[BULK_MAX:]
        try:
            discord.request("POST", f"{discord.path}/bulk-delete", json={"messages": group})
        except RuntimeError as error:
            if getattr(error, "status", None) != 403:
                raise
            print("\nThe bot can't bulk delete (no Manage Messages permission); deleting one at a time.", file=sys.stderr)
            old = group + recent + old
            recent = []
            break
        deleted += len(group)
        progress()
    for message_id in recent + old:
        discord.delete(message_id)
        deleted += 1
        progress()
    print(file=sys.stderr)
    return deleted


def main():
    token = getpass.getpass("Bot token: ").strip()
    channel_id = input("Channel ID: ").strip()
    if not token or not channel_id:
        sys.exit("Both the bot token and the channel ID are needed.")
    discord = Discord(token, channel_id)
    try:
        name = discord.channel_name()
        print(f"\n#{name}")
        messages = all_messages(discord)
        if not messages:
            print("The channel is already empty.")
            return
        summarize(messages)
        answer = input(f"\nDelete all {len(messages)} messages in #{name}? This can't be undone. Type the channel name to confirm: ")
        if answer.strip().lstrip("#") != name:
            print("Nothing was deleted.")
            return
        deleted = delete_all(discord, messages)
        print(f"Deleted {deleted} messages from #{name}.")
    except KeyboardInterrupt:
        sys.exit("\nStopped.")
    except Exception as error:
        sys.exit(f"\nFailed: {error}")


if __name__ == "__main__":
    main()
