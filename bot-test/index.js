// Placeholders: put your values here to have them pre-filled, or paste them into the page.
const BOT_TOKEN = "YOUR_BOT_TOKEN_HERE";
const CHANNEL_ID = "YOUR_CHANNEL_ID_HERE";

const DISCORD_API = "https://discord.com/api/v10";
const $ = (id) => document.getElementById(id);

if (!BOT_TOKEN.startsWith("YOUR_")) $("token").value = BOT_TOKEN;
if (!CHANNEL_ID.startsWith("YOUR_")) $("channel").value = CHANNEL_ID;

async function call(method, path, body) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  $("status").textContent = "Sending…";
  $("status").className = "";
  try {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        "Authorization": `Bot ${$("token").value.trim()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    $("status").textContent = `Discord responded ${res.status} ${res.ok ? "— success" : "— failed"}`;
    $("status").className = res.ok ? "ok" : "err";
    return { ok: res.ok, data };
  } catch (err) {
    $("status").textContent = "Request blocked or network error (see console)";
    $("status").className = "err";
    $("output").textContent = String(err);
    return { ok: false };
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$("send").onclick = async () => {
  const { data } = await call("POST", `/channels/${$("channel").value.trim()}/messages`, {
    content: $("content").value || "hello",
  });
  if (data !== undefined) $("output").textContent = JSON.stringify(data, null, 2);
};

$("read").onclick = async () => {
  const { ok, data } = await call("GET", `/channels/${$("channel").value.trim()}/messages?limit=5`);
  if (data === undefined) return;
  $("output").textContent = ok
    ? data.map((m) => `${m.author.username}: ${m.content || "(empty — see Message Content intent)"}` +
        (m.attachments.length ? `  [${m.attachments.length} attachment(s)]` : "")).join("\n")
    : JSON.stringify(data, null, 2);
};
