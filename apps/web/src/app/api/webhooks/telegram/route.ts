import { after } from "next/server";
import { handleInbound } from "@/lib/channels/conversation";
import { flushTraces } from "@/lib/telemetry";
import { type TelegramUpdate, TelegramNotConfiguredError, telegramInbound, telegramSender, telegramToken, verifyTelegramSecret } from "@/lib/channels/telegram";

export const maxDuration = 60;

/**
 * Telegram updates. In production Telegram calls this directly (setWebhook); in local
 * development `npm run telegram:dev` long-polls Telegram and forwards updates here.
 */
export async function POST(request: Request) {
  let token;
  try {
    token = telegramToken();
  } catch (error) {
    if (error instanceof TelegramNotConfiguredError) return Response.json({ error: error.message }, { status: 503 });
    throw error;
  }
  if (!verifyTelegramSecret(request.headers.get("x-telegram-bot-api-secret-token"), token)) {
    return new Response("Invalid secret", { status: 401 });
  }

  const inbound = telegramInbound((await request.json()) as TelegramUpdate);

  // Answer Telegram at once (it retries failed deliveries), then transcribe, think and reply.
  if (inbound) {
    after(async () => {
      try {
        await handleInbound(inbound, telegramSender);
      } catch (error) {
        console.error("[munshi] Telegram update failed:", error);
        await telegramSender.sendText(inbound.chatId, "Sorry, something went wrong on my side. Please try again in a minute.").catch(() => {});
      } finally {
        await flushTraces();
      }
    });
  }
  return new Response("OK", { status: 200 });
}
