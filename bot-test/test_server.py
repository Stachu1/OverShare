"""Standalone test page: send a message to a Discord channel through the bot REST API.

Run:  python bot-test/test_server.py   then open http://localhost:7879
"""
import os

import requests
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__)
DISCORD_API = "https://discord.com/api/v10"
HERE = os.path.dirname(os.path.abspath(__file__))


def discord(method, path, token, **kwargs):
    response = requests.request(
        method,
        f"{DISCORD_API}{path}",
        headers={"Authorization": f"Bot {token}"},
        timeout=30,
        **kwargs,
    )
    try:
        body = response.json()
    except ValueError:
        body = response.text
    return jsonify({"status": response.status_code, "ok": response.ok, "body": body})


@app.get("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.post("/api/check")
def check():
    data = request.get_json(force=True)
    return discord("GET", "/users/@me", data.get("token", "").strip())


@app.post("/api/send")
def send():
    data = request.get_json(force=True)
    channel_id = data.get("channel_id", "").strip()
    return discord(
        "POST",
        f"/channels/{channel_id}/messages",
        data.get("token", "").strip(),
        json={"content": data.get("content") or "hello"},
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=7879, debug=True)
