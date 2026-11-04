import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { type ChannelSender, decisionPayload, type Inbound, parseDecisionPayload } from "./types";

// WhatsApp Cloud API (Graph API v26.0). Built on the same conversation core as Telegram,
// but not yet tested against Meta: it needs a Meta app and a public https URL.
// Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp

export class WhatsAppNotConfiguredError extends Error {
  constructor() {
    super("WhatsApp is not configured. Add WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET to apps/web/.env.local.");
    this.name = "WhatsAppNotConfiguredError";
  }
}

export function whatsappConfig() {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!token || !phoneNumberId || !appSecret) throw new WhatsAppNotConfiguredError();
  const version = process.env.WHATSAPP_GRAPH_VERSION || "v26.0";
  return { token, phoneNumberId, appSecret, graph: `https://graph.facebook.com/${version}` };
}

/** Meta signs webhooks as "sha256=" + hex(HMAC-SHA256(rawBody, appSecret)). Check the raw body, not re-serialised JSON. */
export function verifyWhatsAppSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex"));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** WhatsApp ids and numbers arrive as "919800000001" or "+919800000001"; store digits only. */
export function phoneDigits(phone: string) {
  return phone.replace(/\D/g, "");
}

// --- Incoming webhook payload (the parts Munshi uses) ---------------------------------

export type InboundMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  audio?: { id: string; mime_type: string; voice?: boolean };
  interactive?: { type: string; button_reply?: { id: string; title: string } };
};

export type WebhookPayload = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: InboundMessage[];
      };
    }[];
  }[];
};

/** Flattens a webhook into the messages it carries (status updates carry none). */
export function inboundMessages(payload: WebhookPayload, phoneNumberId: string) {
  const out: { message: InboundMessage; profileName?: string }[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      // Ignore events for a different business number on the same app.
      if (change.field !== "messages" || value?.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const message of value.messages ?? []) {
        const contact = value.contacts?.find((c) => c.wa_id && phoneDigits(c.wa_id) === phoneDigits(message.from));
        out.push({ message, profileName: contact?.profile?.name });
      }
    }
  }
  return out;
}

// --- Graph API calls --------------------------------------------------------------------

async function graph<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { token, graph: base } = whatsappConfig();
  const res = await fetch(path.startsWith("https://") ? path : `${base}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Downloads an incoming media file (voice note). Media URLs expire after 5 minutes, so fetch right away. */
export async function downloadMedia(mediaId: string): Promise<Blob> {
  const { token, phoneNumberId } = whatsappConfig();
  const meta = await graph<{ url: string; mime_type: string }>(`${mediaId}?phone_number_id=${phoneNumberId}`);
  const res = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`WhatsApp media download ${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: meta.mime_type });
}

async function uploadMedia(bytes: Uint8Array, mimeType: string, filename: string): Promise<string> {
  const { phoneNumberId } = whatsappConfig();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }), filename);
  const { id } = await graph<{ id: string }>(`${phoneNumberId}/media`, { method: "POST", body: form });
  return id;
}

async function send(to: string, message: Record<string, unknown>) {
  const { phoneNumberId } = whatsappConfig();
  await graph(`${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...message }),
  });
}

const LINK_CODE = /^\s*munshi\s+(\d{6})\s*$/i;

/** Turns a webhook message into an Inbound for the shared conversation core. */
export function whatsappInbound(message: InboundMessage, profileName?: string): Inbound {
  const base = { channel: "whatsapp" as const, updateId: message.id, chatId: phoneDigits(message.from), profileName };
  if (message.type === "text" && message.text) {
    const code = LINK_CODE.exec(message.text.body)?.[1];
    return code ? { ...base, kind: "link", code } : { ...base, kind: "text", text: message.text.body };
  }
  if (message.type === "audio" && message.audio) {
    const mediaId = message.audio.id;
    return { ...base, kind: "voice", filename: "voice-note.ogg", download: () => downloadMedia(mediaId) };
  }
  const decision = message.interactive?.button_reply ? parseDecisionPayload(message.interactive.button_reply.id) : null;
  if (decision) return { ...base, kind: "decision", ...decision };
  return { ...base, kind: "unsupported" };
}

export const whatsappSender: ChannelSender = {
  async sendText(to, text, buttons) {
    // WhatsApp text messages can't carry URL buttons, so links go inline.
    const extra = buttons?.length ? "\n\n" + buttons.map((b) => `${b.text}: ${b.url}`).join("\n") : "";
    await send(to, { type: "text", text: { body: (text + extra).slice(0, 4096), preview_url: true } });
  },

  async sendVoice(to, mp3) {
    // WhatsApp audio accepts MP3, AAC, AMR, M4A and Opus OGG, not WAV.
    const id = await uploadMedia(mp3, "audio/mpeg", "munshi-reply.mp3");
    await send(to, { type: "audio", audio: { id } });
  },

  async sendApproval(to, prompt, approvalId) {
    await send(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: prompt.slice(0, 1024) },
        action: {
          buttons: [
            { type: "reply", reply: { id: decisionPayload(approvalId, true), title: "Haan, bhejo" } },
            { type: "reply", reply: { id: decisionPayload(approvalId, false), title: "Nahi" } },
          ],
        },
      },
    });
  },
};
