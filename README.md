# Discord Big Files

A browser extension (Chrome/Edge, Manifest V3) with a MetaMask-style popup for
sending large files to Discord — including **DMs**. Because Discord caps upload
size per file, the end goal is to **split a file into chunks**, send each chunk,
then **reassemble** on the receiving end.

Stages:

1. **Send one file** ✅
2. **Split a big file into chunks** and send each ✅
3. **Download the chunks and stitch them back together** ✅

The popup has two tabs — **Send** and **Download** — sharing the token and
channel/DM id at the top.

## Chunking (Send tab)

Set **Chunk size (MB)** (default 8). If the file is larger, it's sliced with
`Blob.slice` into `ceil(size / chunkSize)` parts, each named `<name>.<i>_<total>`
(1-based) — e.g. `movie.mp4.1_3`, `movie.mp4.2_3`, `movie.mp4.3_3`. Smaller files
are sent as-is with their original name. The optional message rides on the first
part only. Rate limits (HTTP 429) are waited out and retried automatically.

### Bundling chunks into fewer messages

Discord allows up to **10 attachments per message**, bounded by a total size
limit. **Max / message (MB)** (default 25) controls how many chunks are packed
into one message: `min(10, floor(maxPerMsg / chunkSize))`. So 8 MB chunks with a
25 MB budget go 3-per-message. The live readout shows `→ N chunks · M messages`.

Bundling can't beat the size cap — a genuinely large file still spans multiple
messages. If a message 413s, lower the chunk size or the per-message budget.
Reassembly doesn't care how chunks were packed; it groups by filename.

## Download tab

**Refresh** reads the last 100 messages of the channel via
`GET /channels/<id>/messages`, groups attachments by the `<i>_<total>` naming,
and lists each file with its chunk count / size (incomplete sets are flagged and
not downloadable). **Download** fetches every part from Discord's CDN in order,
concatenates the blobs, and saves under the original name (suffix stripped).
Plain, non-chunked attachments are listed too, as single-part files.

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
2. Click the extension icon → **Detect**. This reads your token and the current
   channel id straight from that tab. (You can also paste both manually.)
3. Drop a file, optionally add a message, **Send**.

Token + channel are saved in `chrome.storage.local` so you don't re-enter them.

### Getting the values manually

- **Token:** DevTools (F12) → **Application → Local Storage → discord.com** →
  `token`. (The console can't read it; the Application panel can.)
- **Channel id:** it's in the URL — `discord.com/channels/@me/<id>` for a DM, or
  `discord.com/channels/<server>/<id>` for a server channel.

### How Detect reads the token

Discord runs `delete window.localStorage` on the top frame to stop console/paste
grabbers, so a direct read returns nothing. The extension instead creates a
throwaway same-origin `<iframe>` — localStorage is shared per origin, and Discord
only deletes it on the top window — reads `token`, then removes the iframe. The
token is used only to call Discord from your browser; it is never sent anywhere
else.

## Known limits

- **Reassembly is in-memory** — the whole file is held as a `Blob` before saving,
  so multi-GB files can strain memory. A streaming save (via a background service
  worker) would fix this if it becomes a problem.
- **Download saves from the popup** — if you close the popup mid-download of a
  very large file, the object URL can be revoked before Chrome finishes reading
  it. Keep the popup open until the save starts.
- Only the last **100 messages** are scanned. Paging further back is a small
  follow-up (`before=<message_id>`) if you need deeper history.
