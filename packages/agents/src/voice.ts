// Sarvam speech APIs: Saaras (speech → text) and Bulbul (text → speech).
// Docs: https://docs.sarvam.ai/api-reference/speech-to-text/transcribe
//       https://docs.sarvam.ai/api-reference/text-to-speech/convert

const SARVAM_API = "https://api.sarvam.ai";
const TTS_MAX_CHARS = 2500;

export type ShopLanguage = "kn" | "hi" | "ta" | "bn" | "en";

/** Shop language → BCP-47 code Sarvam expects. */
export const SARVAM_LANGUAGE: Record<ShopLanguage, string> = {
  kn: "kn-IN",
  hi: "hi-IN",
  ta: "ta-IN",
  bn: "bn-IN",
  en: "en-IN",
};

const TTS_LANGUAGES = new Set(["bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"]);

export class SarvamSpeechError extends Error {
  constructor(
    readonly status: number,
    body: string,
    what: string,
  ) {
    super(`Sarvam ${what} failed (${status}): ${body.slice(0, 300)}`);
    this.name = "SarvamSpeechError";
  }
}

export type Transcript = { transcript: string; languageCode: string | null };

/**
 * Transcribes a short (< 30s) clip with saaras:v4. The language is auto-detected because
 * shopkeepers code-mix; `keyterms` biases recognition toward customer and product names.
 */
export async function transcribe(opts: {
  apiKey: string;
  audio: Blob;
  filename?: string;
  keyterms?: string[];
  fetch?: typeof fetch;
}): Promise<Transcript> {
  const form = new FormData();
  // Sarvam matches the MIME type exactly, so drop codec parameters ("audio/webm;codecs=opus" → "audio/webm").
  const baseType = opts.audio.type.split(";")[0]!.trim() || "application/octet-stream";
  form.append("file", new Blob([opts.audio], { type: baseType }), opts.filename ?? "speech.webm");
  form.append("model", "saaras:v4");
  form.append("language_code", "unknown");
  const keyterms = [...new Set(opts.keyterms ?? [])].map((t) => t.trim().slice(0, 64)).filter(Boolean).slice(0, 50);
  if (keyterms.length) form.append("keyterms", JSON.stringify(keyterms));

  const res = await (opts.fetch ?? fetch)(`${SARVAM_API}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": opts.apiKey },
    body: form,
  });
  if (!res.ok) throw new SarvamSpeechError(res.status, await res.text(), "speech-to-text");
  const data = (await res.json()) as { transcript?: string; language_code?: string | null };
  return { transcript: (data.transcript ?? "").trim(), languageCode: data.language_code ?? null };
}

export type DetectedLanguage = { languageCode: string; scriptCode: string | null };

/**
 * Sarvam language identification. Unlike a script check, this also reads Indian languages
 * typed in English letters: "Ramesh eshtu baaki ide?" comes back as kn-IN in Latn.
 */
export async function detectLanguage(opts: { apiKey: string; text: string; fetch?: typeof fetch }): Promise<DetectedLanguage | null> {
  const res = await (opts.fetch ?? fetch)(`${SARVAM_API}/text-lid`, {
    method: "POST",
    headers: { "api-subscription-key": opts.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ input: opts.text.slice(0, 1000) }),
  });
  if (!res.ok) throw new SarvamSpeechError(res.status, await res.text(), "language detection");
  const data = (await res.json()) as { language_code?: string | null; script_code?: string | null };
  return data.language_code ? { languageCode: data.language_code, scriptCode: data.script_code ?? null } : null;
}

/** Makes an agent reply speakable: drops markdown and caps the length Bulbul accepts. */
export function speakableText(text: string) {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= TTS_MAX_CHARS) return plain;
  const cut = plain.slice(0, TTS_MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf("।"), cut.lastIndexOf("."), cut.lastIndexOf("?"));
  return lastStop > TTS_MAX_CHARS / 2 ? cut.slice(0, lastStop + 1) : cut;
}

/** Speaks `text` with Bulbul and returns audio bytes (WAV for browsers, MP3 for WhatsApp). */
export async function synthesize(opts: {
  apiKey: string;
  text: string;
  languageCode: string;
  model?: string;
  speaker?: string;
  codec?: "wav" | "mp3";
  fetch?: typeof fetch;
}): Promise<Uint8Array> {
  const text = speakableText(opts.text);
  if (!text) throw new Error("Nothing to speak");
  const languageCode = TTS_LANGUAGES.has(opts.languageCode) ? opts.languageCode : "en-IN";

  const res = await (opts.fetch ?? fetch)(`${SARVAM_API}/text-to-speech`, {
    method: "POST",
    headers: { "api-subscription-key": opts.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      language_code: languageCode,
      model: opts.model ?? "bulbul:v3",
      ...(opts.speaker ? { speaker: opts.speaker } : {}),
      pace: 1.05,
      output_audio_codec: opts.codec ?? "wav",
    }),
  });
  if (!res.ok) throw new SarvamSpeechError(res.status, await res.text(), "text-to-speech");
  const data = (await res.json()) as { audios?: string[] };
  const audio = data.audios?.[0];
  if (!audio) throw new Error("Sarvam text-to-speech returned no audio");
  return Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
}
