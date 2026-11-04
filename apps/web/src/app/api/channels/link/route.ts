import { randomBytes, randomInt } from "node:crypto";
import type { MessagingChannel } from "@/lib/channels/types";
import { botUsername, TelegramNotConfiguredError } from "@/lib/channels/telegram";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const CODE_TTL_MS = 15 * 60 * 1000;

function channelParam(request: Request): MessagingChannel | null {
  const channel = new URL(request.url).searchParams.get("channel");
  return channel === "telegram" || channel === "whatsapp" ? channel : null;
}

async function signedInMerchantId() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return null;
  const { data } = await supabase.from("merchants").select("id").single();
  return data?.id ?? null;
}

/**
 * Issues a one-time link code. Telegram gets a t.me deep link (one tap opens the bot and
 * sends the code); WhatsApp gets a 6-digit code to send from the owner's phone.
 */
export async function POST(request: Request) {
  const channel = channelParam(request);
  if (!channel) return Response.json({ error: "Unknown channel." }, { status: 400 });
  const merchantId = await signedInMerchantId();
  if (!merchantId) return Response.json({ error: "Sign in first." }, { status: 401 });

  let url: string | null = null;
  const code = channel === "telegram" ? randomBytes(18).toString("base64url") : String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (channel === "telegram") {
    try {
      url = `https://t.me/${await botUsername()}?start=${code}`;
    } catch (error) {
      const message = error instanceof TelegramNotConfiguredError ? error.message : "Couldn't reach Telegram. Check TELEGRAM_BOT_TOKEN.";
      return Response.json({ error: message }, { status: 503 });
    }
  } else if (process.env.WHATSAPP_DISPLAY_NUMBER) {
    url = `https://wa.me/${process.env.WHATSAPP_DISPLAY_NUMBER.replace(/\D/g, "")}?text=${encodeURIComponent(`MUNSHI ${code}`)}`;
  }

  // Codes are server-only (no RLS policies), so the admin client writes them for this merchant.
  const admin = createAdminClient();
  await admin.from("channel_link_codes").delete().eq("merchant_id", merchantId).eq("channel", channel);
  const { error } = await admin
    .from("channel_link_codes")
    .insert({ code, merchant_id: merchantId, channel, expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  if (error) return Response.json({ error: "Couldn't create a link. Try again." }, { status: 500 });

  return Response.json({ code, url });
}

/** Disconnects the channel and forgets its conversation. */
export async function DELETE(request: Request) {
  const channel = channelParam(request);
  if (!channel) return Response.json({ error: "Unknown channel." }, { status: 400 });
  const merchantId = await signedInMerchantId();
  if (!merchantId) return Response.json({ error: "Sign in first." }, { status: 401 });
  const admin = createAdminClient();
  await admin.from("channel_links").delete().eq("merchant_id", merchantId).eq("channel", channel);
  await admin.from("agent_threads").delete().eq("merchant_id", merchantId).eq("channel", channel);
  return new Response(null, { status: 204 });
}
