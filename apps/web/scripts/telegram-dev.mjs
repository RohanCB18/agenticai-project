// Telegram without a public URL. Telegram can only call https webhooks, so in local
// development this script long-polls Telegram (getUpdates) and forwards each update to the
// local webhook route with the same secret header Telegram would send.
//
//   npm run telegram:dev                         poll and forward to http://localhost:3000
//   npm run telegram:webhook -- https://my.app   point Telegram at a deployed app instead
//
// Reads TELEGRAM_BOT_TOKEN from apps/web/.env.local (via node --env-file).
import { createHmac } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is missing from apps/web/.env.local. Create a bot with @BotFather first.");
  process.exit(1);
}

// Must match telegramWebhookSecret() in src/lib/channels/telegram.ts.
const secret = createHmac("sha256", token).update("munshi-telegram-webhook").digest("base64url");
const allowedUpdates = ["message", "callback_query"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const [mode, appUrl] = process.argv.slice(2);

if (mode === "set-webhook") {
  if (!appUrl?.startsWith("https://")) {
    console.error("Usage: npm run telegram:webhook -- https://your-app.example.com");
    process.exit(1);
  }
  const url = `${appUrl.replace(/\/$/, "")}/api/webhooks/telegram`;
  await api("setWebhook", { url, secret_token: secret, allowed_updates: allowedUpdates });
  console.log(`Telegram now delivers to ${url}`);
  process.exit(0);
}

const target = process.env.MUNSHI_TELEGRAM_FORWARD_URL ?? "http://localhost:3000/api/webhooks/telegram";
await api("deleteWebhook"); // getUpdates doesn't work while a webhook is set
const me = await api("getMe");
console.log(`Polling @${me.username} and forwarding to ${target}. Press Ctrl+C to stop.`);

let offset = 0;
for (;;) {
  try {
    const updates = await api("getUpdates", { offset, timeout: 30, allowed_updates: allowedUpdates });
    for (const update of updates) {
      offset = update.update_id + 1;
      const res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
        body: JSON.stringify(update),
      });
      const kind = update.message?.voice ? "voice" : update.callback_query ? "button" : update.message?.text ? "text" : "other";
      console.log(`${new Date().toLocaleTimeString()} update ${update.update_id} (${kind}) → ${res.status}`);
    }
  } catch (error) {
    console.error(`${new Date().toLocaleTimeString()} ${error.message}; retrying in 3s`);
    await sleep(3000);
  }
}
