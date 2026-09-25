# OverShare

OverShare is a Chrome extension for sending large files and folders through Discord using your own Discord bot. Files are compressed, encrypted in the browser with **AES-256-GCM**, split into chunks, and uploaded to a Discord channel.

No separate server or software is required.

<img width="400" height="640" alt="image" src="https://github.com/user-attachments/assets/30ef4129-3cd4-4096-bc79-fe21474e0dcd" />


## How It Works

### Uploading

1. A random transfer ID and **AES-256** encryption key are generated.
2. Files are streamed and compressed into a ZIP while preserving folder paths.
3. The ZIP is split into **20 MB chunks**.
4. Each chunk is encrypted with AES-256-GCM and uploaded to your Discord channel.
5. A manifest containing the file metadata is uploaded after the chunks.
6. The resulting **file token** (`<id>.<key>`) is required to decrypt the file.

The encryption also protects the order and integrity of the chunks, so modified or missing chunks fail to decrypt.

### Downloading

The extension searches the configured Discord channel for matching manifests and chunks. Files are decrypted and extracted as they are downloaded.

## Setup

### 1. Create a Discord Server

Create a **separate Discord server** with a private transfer channel. Do not use a server containing unrelated content.

### 2. Create a Discord Bot

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and:

- Create a new application and bot.
- Copy the bot token and keep it private.
- Disable **Public Bot**.
- Message Content Intent is not required.
- Generate an OAuth2 invite with:
  - View Channels
  - Send Messages
  - Attach Files
  - Read Message History
  - Manage Channels (only needed to let OverShare create channels for you)
- Add the bot only to your OverShare server.

### 3. Get the Channel ID

Enable **Developer Mode** in Discord, then right-click your transfer channel and select **Copy Channel ID**.

Instead of an ID you can type a name, such as `minecraft-world-saves` or `documents`. If no channel with that name exists, OverShare offers to create it and saves its ID in the configuration, which makes it quick to keep a separate configuration for each purpose. The channel is created in the server of another configuration with the same bot (in the same category, so it inherits its privacy), or in the bot's only server.

### 4. Install OverShare

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the OverShare folder.
5. Open the extension and enter your **bot token** and **channel ID** (or a name for a new channel).

## Usage

- **Send:** Drop a file or folder into the popup and click **Send**.
- **Download:** Open the Download tab and provide a file token if necessary.
- **Copy Token:** Save or share the token with someone who should access that file.
- **Export / Import Tokens:** Back up your file tokens as JSON.
- **Delete:** Removes the transfer from Discord and removes its local token.

### Sending from the command line

`upload.py` sends a file the same way the extension does, without a browser:

```sh
pip install requests cryptography
BOT_TOKEN=... CHANNEL_ID=... python upload.py file.mp4
```

It prints the file token and adds it to `overshare-tokens.json` next to the script. Load that file with **Import Tokens**, or paste the single token into the Download tab, while the configuration with the same bot and channel is selected. Keep the tokens file private.

## Security

There are two important secrets:

| Secret | Access |
|---|---|
| **Bot token** | Allows control of everything the bot can access, including reading, uploading, and deleting messages. |
| **File token** | Allows decryption of the specific file it belongs to. |

Important security considerations:

- Use a dedicated bot and server.
- Never publish or share the bot token publicly.
- Only share file tokens with people who should access the corresponding file.
- Anyone with the bot token may be able to delete OverShare transfers.
- The bot token is stored unencrypted in the extension's local storage.
- Keep token-export files private because they contain your file encryption keys.
- If the bot token is compromised, reset it immediately in the Discord Developer Portal.

## Limits and Notes

- Chunks are **20 MB**. Discord/server upload limits may require a smaller size.
- Large transfers use streaming to reduce memory usage.
- Discord rate limits may slow transfers; OverShare automatically retries.
- Closing the popup does not stop transfers, but closing the browser does.
- Interrupted or partial uploads are cleaned up when possible.
- Transfers from versions before **4.0** are no longer downloadable.
- The file list and deletion system search up to the latest **10,000 messages**.
- Folder downloads may be saved as a ZIP if the browser cannot maintain folder write access.

## Project Structure

| File | Purpose |
|---|---|
| `manifest.json` | Chrome extension manifest |
| `rules.json` | Discord API request configuration |
| `popup.html`, `popup.js` | Extension interface |
| `offscreen.html`, `engine.js` | Compression, encryption, uploads, and downloads |
| `background.js` | Service worker and background tasks |
| `shared.js` | Discord API, transfer, and decryption utilities |
| `fflate.js` | ZIP/compression library |
| `upload.py` | Command-line sender, same format as the extension |

## Disclaimer

**For educational purposes only.**

OverShare is provided for learning, experimentation, and authorized use only. Do not use this project to abuse Discord, bypass platform restrictions, distribute unauthorized content, access data you do not own, or violate Discord's Terms of Service or applicable laws.

Misuse may result in account or server bans, suspension, loss of access, or other consequences. You are responsible for how you use this project and for complying with all applicable laws, rules, and terms of service.

The authors are not responsible for misuse, account bans, lost data, security issues, or any other consequences resulting from the use of this project.
