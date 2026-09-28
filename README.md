# OverShare

OverShare is a Chrome extension for sending large files and folders through Discord with your own bot. Files are compressed, encrypted in the browser with **AES-256-GCM**, split into chunks and uploaded to a Discord channel. No server or other software is needed.

<img width="400" height="640" alt="image" src="https://github.com/user-attachments/assets/30ef4129-3cd4-4096-bc79-fe21474e0dcd" />

## How It Works

1. Each transfer gets a random ID and AES-256 key.
2. Files are streamed into a ZIP (folder paths kept) and split into **20 MB chunks**.
3. Each chunk is encrypted and uploaded, up to **10 chunks per message** through Discord's upload API, falling back to one chunk per message if that fails.
4. A manifest with the file metadata is uploaded last.
5. The **file token** (`<id>.<key>`) is needed to decrypt the file. The encryption also protects chunk order and integrity, so modified or missing chunks fail to decrypt.

To download, the extension finds the manifest and chunks in the channel, then decrypts and extracts them as they arrive.

## Setup

1. **Server:** create a separate Discord server with a private transfer channel, with nothing unrelated in it.
2. **Bot:** in the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot, copy the bot token and disable **Public Bot** (Message Content Intent is not needed). Invite it to that server only, with:
   - View Channels, Send Messages, Attach Files, Read Message History
   - Manage Channels (optional, lets OverShare create channels)
   - Manage Messages (optional, lets `clear_channel.py` delete in bulk)
3. **Channel:** enable Developer Mode in Discord, right-click the channel and **Copy Channel ID**. Or type a name such as `documents`: if no such channel exists, OverShare offers to create it, in the server (and category) of another configuration with the same bot, or in the bot's only server. This makes a configuration per purpose quick to set up.
4. **Install:** open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, click **Load unpacked** and pick the OverShare folder. Then enter the bot token and channel in the extension.

## Usage

- **Send:** drop a file or folder into the popup and click **Send**. Closing the popup doesn't stop a transfer; closing the browser does.
- **Download:** open the Download tab, or paste a file token someone shared with you.
- **Copy / Export / Import tokens:** share a single file token, or back up all of them as JSON.
- **Delete:** removes the transfer from Discord and its token from the extension.
- **Configurations:** keep several bots and channels, and drag to reorder them. The header buttons switch the theme and mute sounds.

### Open channels

A channel whose name starts with `open_` is open: files are encrypted with one key built into OverShare instead of their own, so everyone with the bot token and OverShare sees and downloads every file without tokens. It only hides the files from people reading the channel without OverShare, so don't send anything private there. Tick **Open** when creating a new channel to name it `open_<name>`; an existing channel given by ID is never opened.

### Command line

```sh
pip install requests cryptography
BOT_TOKEN=... CHANNEL_ID=... python upload.py file.mp4
python clear_channel.py
```

- `upload.py` sends a file the same way the extension does, prints its token and adds it to `overshare-tokens.json`. Load that file with **Import Tokens** under the configuration with the same bot and channel. Open channels need no token.
- `clear_channel.py` shows what the channel holds (OverShare files, unfinished uploads, other messages and their size) and deletes every message after you type the channel name. Messages under two weeks old go in bulk with **Manage Messages**; otherwise one at a time.

## Security

- The **bot token** controls everything the bot can reach, including reading and deleting transfers. It is stored unencrypted in the extension; never share it publicly, and reset it in the Developer Portal if it leaks.
- A **file token** decrypts only its own file. Share it only with people who should have that file, and keep token exports private.

## Limits

- Discord or server upload limits may need smaller chunks than 20 MB. Rate limits slow transfers; OverShare retries automatically.
- The file list and deletes search the latest **10,000 messages**.
- Interrupted uploads are cleaned up when possible.
- Transfers from before **4.0** can't be downloaded, and files sent with **5.27+** need 5.27+ to download.
- Folder downloads fall back to a ZIP if the browser can't keep folder write access.

## Project Structure

| File | Purpose |
|---|---|
| `manifest.json`, `rules.json` | Extension manifest and Discord request headers |
| `popup.html`, `popup.js` | Interface |
| `offscreen.html`, `engine.js` | Compression, encryption, uploads and downloads |
| `background.js` | Service worker |
| `shared.js` | Discord API, transfer and decryption utilities |
| `fflate.js` | ZIP library ([fflate](https://github.com/101arrowz/fflate)) |
| `upload.py`, `clear_channel.py` | Command-line sender and channel cleaner |

## License

OverShare is free for any **noncommercial** use under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use needs separate permission. Bundled third-party code keeps its own license; see [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).

## Disclaimer

**For educational purposes only.** Use OverShare only for authorized purposes. Don't use it to abuse Discord, bypass platform restrictions, distribute unauthorized content or break Discord's Terms of Service or the law; misuse can get accounts or servers banned. You are responsible for how you use it, and the authors are not liable for misuse, bans, lost data or any other consequences.
