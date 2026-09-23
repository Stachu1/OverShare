# OverShare

A browser extension (Chrome/Edge, Manifest V3) with a MetaMask-style popup for
sending large **files and folders** to Discord — including **DMs**. Each transfer
is **zipped**, **SHA-256 fingerprinted**, **split into chunks** to beat Discord's
per-file cap, and **reassembled + verified** on download.

The popup has two tabs — **Send** and **Download** — sharing the token and
channel/DM id at the top.

## Send tab

Pick a **file** (click the zone, or drop a file) or a **folder** (the
*Or pick a folder…* button, or drag a folder onto the zone). A browser file input
is either files-only or folders-only, so clicking the zone opens the *file*
picker; use the folder button (or drag) for folders. The selection is zipped
immediately (with a fixed mtime, so identical content yields an identical
archive/hash) and the popup shows `original → zipped` size.

**Chunk size (MB)** (default 8) slices the zip into `ceil(zipSize / chunkSize)`
parts named `<name>.zip.<i>_<total>` (1-based) — e.g. `movie.mp4.zip.1_3`. Rate
limits (HTTP 429) are waited out and retried automatically.

### Integrity manifest

The transfer's **first message** is a manifest — a human summary plus a machine
line `OVERSHARE|{json}` carrying `{name, kind, base, total, originalSize,
zippedSize, sha256, entries}`. It's posted as a **spoiler-wrapped code block**
(` ||```text … ``` || `) so it stays tidy and hidden in the channel. The Download
tab reads it to label files, show their real size, and **verify the SHA-256** of
the reassembled bytes before unpacking. A mismatch aborts the save rather than
handing back a corrupt file.

### Bundling chunks into fewer messages

Discord allows up to **10 attachments per message**, bounded by a total size
limit. **Max / message (MB)** (default 40) controls how many chunks are packed
into one message: `min(10, floor(maxPerMsg / chunkSize))`. So 8 MB chunks with a
40 MB budget go 5-per-message. The live readout shows `→ N chunks · M messages`.

Bundling can't beat the size cap — a genuinely large file still spans multiple
messages. If a message 413s, lower the chunk size or the per-message budget.
Reassembly doesn't care how chunks were packed; it groups by filename.

## Download tab

Switching to this tab **auto-loads** the list (silently if token/channel aren't
set yet) by reading messages in batches of 20 via `GET /channels/<id>/messages`.
**Only transfers sent by this tool are listed** — a manifest starts a transfer
and the chunks that follow it (matching base+total, until the next manifest for
that name) belong to it. This *timestamp-proximity* keying means re-sends of the
same file don't merge, and random channel attachments are ignored. Files show
their original name, size, and file/folder kind. Incomplete sets are flagged and
not downloadable. **Load older files** at the top pages further back.

**Download** fetches every part from Discord's CDN in order, concatenates them,
**verifies the SHA-256** against the manifest, then unzips:

- a **single file** is saved under its original name;
- a **folder** is extracted into a directory you pick (via the File System Access
  API), recreating subfolders; if that API is unavailable it falls back to saving
  the `.zip`.

Plain, non-chunked attachments are still listed as single-part files.

## How sending works

The popup posts the file to Discord's API as your own account:

```
POST https://discord.com/api/v10/channels/<channel_id>/messages
Authorization: <your account token>
```

This works for any channel **and DMs** (a DM is just a channel whose id lives at
`discord.com/channels/@me/<id>`).

> **Heads up:** driving your own account through the API with the user token is
> "self-botting", which is against Discord's Terms of Service. It's your account
> that carries the risk. This is a personal tool — use it accordingly.

## Load the extension

1. `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select this folder.

## Use it

1. Open Discord in a tab and go to the DM/channel you want to send to.
2. Click the extension icon. If the popup opens on a Discord tab it **auto-detects**
   your token and the current channel id; off Discord it keeps your last values.
   The token is then validated with a small read request and a **status line under
   the field** shows the result: green *Token valid*, or red *No valid token —
   open Discord and reopen this popup, or paste a token*. Pasting a token
   re-validates immediately.
3. Drop a file, optionally add a message, **Send**.

Token + channel are saved in `chrome.storage.local` so you don't re-enter them.

### Getting the values manually

- **Token:** DevTools (F12) → **Application → Local Storage → discord.com** →
  `token`. (The console can't read it; the Application panel can.)
- **Channel id:** it's in the URL — `discord.com/channels/@me/<id>` for a DM, or
  `discord.com/channels/<server>/<id>` for a server channel. Once a valid token +
  id are set, the resolved **name** (`#channel` or `@recipient`) shows next to the
  field. Every channel that resolves is remembered in the **Saved ▾** dropdown, so
  you can type an id or pick a previous channel/DM by name.

### How the token is auto-detected

Discord runs `delete window.localStorage` on the top frame to stop console/paste
grabbers, so a direct read returns nothing. The extension instead creates a
throwaway same-origin `<iframe>` — localStorage is shared per origin, and Discord
only deletes it on the top window — reads `token`, then removes the iframe. The
token is used only to call Discord from your browser; it is never sent anywhere
else.

## Sound effects

Synthesized on the fly with the Web Audio API (no audio files bundled): a hover
tick and click blip on buttons, an ascending chime on a successful send, and a
two-note cue when a download finishes. The **🔊/🔇 toggle** in the top bar mutes
them (remembered across sessions). The very first hover before any click may be
silent (browsers resume audio only after a user gesture).

## Zip/unzip

Uses [`fflate`](https://github.com/101arrowz/fflate) (bundled as `fflate.js`).
The **synchronous** API is used to stay clear of any MV3 worker/CSP issues, so
zipping/unzipping happens on the popup thread.

## Known limits

- **Everything is in-memory** — zipping reads all selected files into memory, and
  reassembly/unzip holds the archive and its contents at once. Fine for normal
  sizes; multi-GB transfers can strain memory and briefly freeze the popup during
  (un)zip. Streaming (via a background service worker) would fix this.
- **Keep the popup open** until a download/extraction finishes — the work runs in
  the popup, and closing it mid-save can truncate the result.
- **Folder extraction** needs the File System Access API (Chromium) and asks you
  to pick a destination folder. Without it, the folder's `.zip` is saved instead.
- The list starts with the most recent **20 messages**; use **Load older files**
  at the top to page further back in batches of 20 (`before=<oldest message id>`).
  Results accumulate, so chunk sets split across a batch boundary reunite.
