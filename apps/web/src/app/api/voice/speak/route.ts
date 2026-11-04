import { SARVAM_LANGUAGE, type ShopLanguage, synthesize } from "@munshi/agents";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

const Body = z.object({
  text: z.string().min(1).max(5000),
  languageCode: z.string().regex(/^[a-z]{2,3}-IN$/).nullish(),
});

/** Text → speech with Bulbul. Speaks in the language the owner used, else the shop's language. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ error: "Sign in to use Munshi." }, { status: 401 });

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice needs SARVAM_API_KEY in apps/web/.env.local." }, { status: 503 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send { text, languageCode? }." }, { status: 400 });

  let languageCode = parsed.data.languageCode;
  if (!languageCode) {
    const { data: merchant } = await supabase.from("merchants").select("preferred_language").single();
    languageCode = SARVAM_LANGUAGE[(merchant?.preferred_language as ShopLanguage) ?? "hi"];
  }

  try {
    const audio = await synthesize({
      apiKey,
      text: parsed.data.text,
      languageCode,
      model: process.env.SARVAM_TTS_MODEL || undefined,
      speaker: process.env.SARVAM_TTS_SPEAKER || undefined,
    });
    return new Response(new Blob([audio as Uint8Array<ArrayBuffer>]), { headers: { "content-type": "audio/wav", "cache-control": "no-store" } });
  } catch (error) {
    console.error("[munshi] speak failed:", error);
    return Response.json({ error: "Couldn't speak the reply." }, { status: 502 });
  }
}
