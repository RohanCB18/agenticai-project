import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { type ChannelSender, decisionPayload, type Inbound, parseDecisionPayload } from "./types";

// Telegram Bot API (10.3). Docs: https://core.telegram.org/bots/api

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // bots can download files up to 20 MB

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super("Telegram is not configured. Create a bot with @BotFather and add TELEGRAM_BOT_TOKEN to apps/web/.env.local.");
    this.name = "TelegramNotConfiguredError";
  }
}

export function telegramToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramNotConfiguredError();
  return token;
}

/**
 * The secret Telegram echoes in X-Telegram-Bot-Api-Secret-Token on every webhook call.
 * Derived from the bot token so there is no extra key to manage (scripts/telegram-dev.mjs
 * derives the same value).
 */
export function telegramWebhookSecret(token: string) {
  return createHmac("sha256", token).update("munshi-telegram-webhook").digest("base64url");
}

export function verifyTelegramSecret(header: string | null, token: string) {
  if (!header) return false;
  const expected = Buffer.from(telegramWebhookSecret(token));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function call<T>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${telegramToken()}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result as T;
}

let cachedUsername: string | undefined;

/** The bot's @username, for t.me deep links. */
export async function botUsername() {
  cachedUsername ??= (await call<{ username: string }>("getMe", {})).username;
  return cachedUsername;
}

async function downloadFile(fileId: string, mimeType: string): Promise<Blob> {
  const file = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram returned no file path");
  if ((file.file_size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("Voice note is larger than 20 MB");
  const res = await fetch(`https://api.telegram.org/file/bot${telegramToken()}/${file.file_path}`);
  if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: mimeType });
}

// --- Incoming updates (the parts Munshi uses) -------------------------------------------

type Chat = { id: number; type: string };
type User = { id: number; first_name?: string; last_name?: string; username?: string };
type AudioFile = { file_id: string; mime_type?: string; file_size?: number };

export type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; chat: Chat; from?: User; text?: string; voice?: AudioFile; audio?: AudioFile };
  callback_query?: { id: string; from: User; data?: string; message?: { message_id: number; chat: Chat; text?: string } };
};

const nameOf = (user?: User) => [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.username;

/** Turns an update into an Inbound, or null for anything Munshi ignores (groups, edits, joins). */
export function telegramInbound(update: TelegramUpdate): Inbound | null {
  const base = { channel: "telegram" as const, updateId: String(update.update_id) };

  const message = update.message;
  if (message) {
    if (message.chat.type !== "private") return null; // Munshi only works in a 1:1 chat with the owner
    const common = { ...base, chatId: String(message.chat.id), profileName: nameOf(message.from) };
    const start = /^\/start\s+([A-Za-z0-9_-]{6,64})$/.exec(message.text?.trim() ?? "");
    if (start) return { ...common, kind: "link", code: start[1]! };
    if (message.text) return { ...common, kind: "text", text: message.text };
    const audio = message.voice ?? message.audio;
    if (audio) {
      const mimeType = audio.mime_type ?? "audio/ogg";
      return { ...common, kind: "voice", filename: mimeType.includes("mpeg") ? "voice.mp3" : "voice.ogg", download: () => downloadFile(audio.file_id, mimeType) };
    }
    return { ...common, kind: "unsupported" };
  }

  const query = update.callback_query;
  const decision = query?.data ? parseDecisionPayload(query.data) : null;
  if (query && decision && query.message?.chat.type === "private") {
    const chatId = String(query.message.chat.id);
    const original = query.message;
    return {
      ...base,
      chatId,
      profileName: nameOf(query.from),
      kind: "decision",
      ...decision,
      acknowledge: async (result) => {
        const label = { approved: "✅ Approved", denied: "❌ Cancelled", stale: "Already handled" }[result];
        await call("answerCallbackQuery", { callback_query_id: query.id, text: label }).catch(() => {});
        // Replace the buttons with the outcome, so the same request can't be tapped twice.
        await call("editMessageText", { chat_id: chatId, message_id: original.message_id, text: `${original.text ?? ""}\n\n${label}` }).catch(() => {});
      },
    };
  }
  return null;
}

// --- Replies -----------------------------------------------------------------------------

export const telegramSender: ChannelSender = {
  async sendText(chatId, text, buttons) {
    await call("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4096),
      link_preview_options: { is_disabled: true },
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) } } : {}),
    });
  },

  async sendVoice(chatId, mp3) {
    // sendVoice accepts OGG/Opus, MP3 or M4A and shows it as a playable voice message.
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("voice", new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" }), "munshi.mp3");
    await call("sendVoice", form);
  },

  async sendApproval(chatId, prompt, approvalId) {
    await call("sendMessage", {
      chat_id: chatId,
      text: prompt,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Haan, bhejo", callback_data: decisionPayload(approvalId, true), style: "success" },
            { text: "❌ Nahi", callback_data: decisionPayload(approvalId, false), style: "danger" },
          ],
        ],
      },
    });
  },

  async showWorking(chatId, kind) {
    await call("sendChatAction", { chat_id: chatId, action: kind === "voice" ? "record_voice" : "typing" }).catch(() => {});
  },
};
