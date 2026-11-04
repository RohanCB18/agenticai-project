import { SarvamSpeechError, transcribe } from "@munshi/agents";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // the REST API takes clips under 30 seconds

/** Speech → text with Saaras, biased toward this shop's customer and product names. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return Response.json({ error: "Sign in to use Munshi." }, { status: 401 });

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return Response.json({ error: "Voice needs SARVAM_API_KEY in apps/web/.env.local." }, { status: 503 });

  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return Response.json({ error: "No audio received." }, { status: 400 });
  if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "That clip is too long. Keep it under 30 seconds." }, { status: 413 });

  // RLS scopes these to the signed-in shop.
  const [customers, products] = await Promise.all([
    supabase.from("customers").select("name, aliases"),
    supabase.from("products").select("name, aliases"),
  ]);
  const keyterms = [...(customers.data ?? []), ...(products.data ?? [])].flatMap((r) => [r.name as string, ...((r.aliases as string[]) ?? [])]);

  try {
    const result = await transcribe({ apiKey, audio, filename: audio instanceof File ? audio.name : undefined, keyterms });
    return Response.json(result);
  } catch (error) {
    console.error("[munshi] transcribe failed:", error);
    const status = error instanceof SarvamSpeechError && error.status === 429 ? 429 : 502;
    return Response.json({ error: "Couldn't understand the audio. Try again or type it." }, { status });
  }
}
