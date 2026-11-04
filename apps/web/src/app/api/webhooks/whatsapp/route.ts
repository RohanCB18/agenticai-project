import { after } from "next/server";
import { handleInbound } from "@/lib/channels/conversation";
import {
  inboundMessages,
  verifyWhatsAppSignature,
  type WebhookPayload,
  WhatsAppNotConfiguredError,
  whatsappConfig,
  whatsappInbound,
  whatsappSender,
} from "@/lib/channels/whatsapp";

export const maxDuration = 60;

/** Meta's one-time subscription check when the webhook URL is saved in the app dashboard. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (verifyToken && params.get("hub.mode") === "subscribe" && params.get("hub.verify_token") === verifyToken) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  let config;
  try {
    config = whatsappConfig();
  } catch (error) {
    if (error instanceof WhatsAppNotConfiguredError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }

  // The signature covers the exact bytes Meta sent, so read the raw body first.
  const raw = await request.text();
  if (!verifyWhatsAppSignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const inbound = inboundMessages(JSON.parse(raw) as WebhookPayload, config.phoneNumberId).map(({ message, profileName }) =>
    whatsappInbound(message, profileName),
  );

  // Answer Meta at once (it retries slow webhooks), then transcribe, think and reply.
  after(async () => {
    for (const message of inbound) {
      try {
        await handleInbound(message, whatsappSender);
      } catch (error) {
        console.error("[munshi] WhatsApp message failed:", error);
        await whatsappSender.sendText(message.chatId, "Sorry, something went wrong on my side. Please try again in a minute.").catch(() => {});
      }
    }
  });

  return new Response("OK", { status: 200 });
}
