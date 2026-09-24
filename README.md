# OverShare

A Chrome/Edge extension for sending large files and folders through Discord using your own bot. Files are compressed, encrypted in the browser, split into chunks and uploaded to a Discord channel. Anyone with the bot token and a file's token can download it and put it back together. No server or other software is needed; everything runs in the extension.

## How it works

**Sending**

1. Selecting a file or folder picks a random transfer ID and a new random **AES-256** key. The **file token** is `<id>.<key>`.
2. The background engine reads the files 4 MB at a time and compresses them into one zip as it goes ([fflate](https://github.com/101arrowz/fflate)). Every file keeps its path inside the folder.
3. The zip is cut into 20 MB pieces. Each one is encrypted with **AES-256-GCM** and becomes an attachment named `<id>.<n>`; they're posted 10 to a message (Discord's attachment limit). Each encrypted piece is written to the extension's private disk storage until its message goes up, so only about one piece is in memory at a time, whatever the file size.
4. When the last piece is up, a manifest message (`OVERSHARE|{name, size, chunk count, …}`) is posted. Uploads keep going if you close the popup.
5. The file token is saved in the extension. It's the only way to find and decrypt the file, and the key never goes to Discord.

Each piece's encryption covers the transfer ID, the piece's number and whether it's the last one. A changed, reordered, missing or cut-off piece fails to decrypt instead of producing a damaged file.

**Downloading**

1. For each file token you have, the extension searches the channel history for the matching manifest and chunks, and shows whether the file is complete. The Download list shows the newest files first, 4 at a time, and reads further back in the channel as you scroll down.
2. It downloads the pieces one at a time, decrypts each, and unzips as it goes, writing files out as they appear. Folders are written back as folders.

**Why no server is needed:** Discord rejects bot-token requests that carry a browser `User-Agent`. The extension has a `declarativeNetRequest` rule (`rules.json`) that sets `User-Agent: DiscordBot (…)` on its requests to `discord.com/api/`, so the browser can call the bot API directly. An extension can change this header; an ordinary web page can't.

## Setup

### 1. Create a separate Discord server

Make a new server just for OverShare, with one channel for transfers. Don't reuse a server you use for anything else (see [Security](#security-and-sharing)).

### 2. Create a separate bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, and give it a name.
2. Open **Bot**:
   - Click **Reset Token** and copy the token. You'll only see it once.
   - Turn **Public Bot** off, so only you can add it to servers.
   - You don't need **Message Content Intent**: the bot only reads its own messages.
3. Open **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: **View Channels**, **Send Messages**, **Attach Files**, **Read Message History**
   - Open the generated URL and add the bot to your new server. Don't add it to any other server.

### 3. Get the channel ID

In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**. Then right-click your transfer channel and choose **Copy Channel ID**.

### 4. Install the extension

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Open the OverShare popup and paste the bot token and channel ID. They're saved as you type. The dot in the header turns green when the bot can reach the channel.

## Use

- **Send:** drop a file or folder on the popup, or click to pick one, then click **Send**. When it finishes, copy the file token with **Copy Token** or from the Download list.
- **Download:** open the Download tab. Files whose tokens you have are listed automatically. Paste a token someone sent you and click **Load** to add it.
- **Export / Import Tokens** backs up your file tokens as a JSON file. The bot token and channel ID aren't included.
- **Delete** removes a file's messages from Discord and its token from the extension.

## Security and sharing

Two secrets matter, and they protect different things.

| Secret | What someone who has it can do |
|---|---|
| **Bot token** | Everything the bot can do: read, post and delete messages in every channel it can see, and change the bot's profile. They can see and delete every OverShare transfer. They **can't** decrypt a file without its file token. |
| **File token** | Decrypt that one file, if they can also get the encrypted chunks: with the bot token, or as a member of the server who can see the channel. |

This is why OverShare should have **its own bot and its own server**:

- Keep the bot in the OverShare server only. If the token leaks, all anyone can reach is that server's transfer channel, not your other communities or anything else the bot could see.
- **Only give the bot token to friends you trust.** Every friend using OverShare needs the same bot token and channel ID. Each of them can delete everyone's transfers, and anyone they pass the token to can too.
- **Only give a file token to people who should get that file.** Having the bot token doesn't let someone read your files; each file needs its own token.
- Anyone in the server who can see the channel can download the encrypted chunks, but can't read them without the file token. Keep the server small, or make the channel private to the bot.
- Send tokens over something private, like a DM, not a public channel.
- The bot token is stored unencrypted in the extension's local storage. Only install OverShare on computers you trust.
- If the bot token leaks, go to the Developer Portal, open **Bot**, and click **Reset Token**. The old token stops working immediately; give the new one to your friends.
- Token export files contain the keys to your files, so keep them as private as the tokens.

## Limits and good to know

- Chunks are 20 MB. If sending fails with a `413` error, your server's upload limit is lower than that.
- Memory use stays about the same whatever the file size (well under 100 MB), because files are read, compressed and encrypted a piece at a time, and the pieces waiting for their message are kept on disk. A send needs up to 200 MB of free disk space for them.
- Transfers sent with versions before 4.0 use an older format and can't be downloaded any more; they show as missing, and you can still delete them.
- Sends, downloads and deletes run in the background and keep going after you close the popup. Closing the browser stops them.
- Cancelling or a failed send removes the chunks already sent. So does a send cut off by closing the browser: its leftovers are removed the next time the browser starts. If that cleanup can't reach Discord, the partial file stays in the Download list so you can delete it there.
- For a folder download, the popup asks where to save before the download starts. If the browser doesn't keep write access to that folder once the popup closes, the folder is saved as a zip instead.
- The file list and delete read up to the latest 10,000 messages in the channel.
- Discord rate-limits bots. OverShare waits and retries automatically, which can slow down large transfers.

## Project layout

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `rules.json` | Sets the `DiscordBot` User-Agent on Discord API requests |
| `popup.html`, `popup.js` | The popup: file selection, settings, file list, progress |
| `offscreen.html`, `engine.js` | Background engine: streams sends (zip, encrypt, upload) and downloads, runs deletes, cleans up partial sends |
| `background.js` | Service worker: starts the engine (also after a restart with an interrupted send) and saves files and storage for it |
| `shared.js` | Discord API client, transfer search, delete, download and decrypt, and speed/ETA helpers |
| `fflate.js` | Zip library |
