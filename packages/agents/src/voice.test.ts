import { describe, expect, it } from "vitest";
import { speakableText, synthesize, transcribe } from "./voice";

function fakeFetch(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("transcribe", () => {
  it("sends saaras:v4 with auto-detect and deduplicated keyterms", async () => {
    const { fn, calls } = fakeFetch({ transcript: " Ramesh ne 450 liya ", language_code: "hi-IN" });
    const result = await transcribe({ apiKey: "k", audio: new Blob(["x"]), keyterms: ["Ramesh", "Ramesh", " Fatima "], fetch: fn });

    expect(result).toEqual({ transcript: "Ramesh ne 450 liya", languageCode: "hi-IN" });
    const form = calls[0]!.init.body as FormData;
    expect(calls[0]!.url).toBe("https://api.sarvam.ai/speech-to-text");
    expect(form.get("model")).toBe("saaras:v4");
    expect(form.get("language_code")).toBe("unknown");
    expect(JSON.parse(form.get("keyterms") as string)).toEqual(["Ramesh", "Fatima"]);
  });

  it("strips codec parameters from the audio type", async () => {
    const { fn, calls } = fakeFetch({ transcript: "ok" });
    await transcribe({ apiKey: "k", audio: new Blob(["x"], { type: "audio/webm;codecs=opus" }), fetch: fn });
    expect(((calls[0]!.init.body as FormData).get("file") as Blob).type).toBe("audio/webm");
  });

  it("throws with Sarvam's error body", async () => {
    const { fn } = fakeFetch({ error: "bad audio" }, 400);
    await expect(transcribe({ apiKey: "k", audio: new Blob(["x"]), fetch: fn })).rejects.toThrow(/speech-to-text failed \(400\).*bad audio/);
  });
});

describe("synthesize", () => {
  it("decodes the base64 WAV and falls back to English for unsupported languages", async () => {
    const { fn, calls } = fakeFetch({ audios: [btoa("RIFF")] });
    const audio = await synthesize({ apiKey: "k", text: "**Likh diya**", languageCode: "xx-IN", fetch: fn });

    expect(new TextDecoder().decode(audio)).toBe("RIFF");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ text: "Likh diya", language_code: "en-IN", model: "bulbul:v3" });
  });
});

describe("speakableText", () => {
  it("drops links and markdown", () => {
    expect(speakableText("Link: https://payments-test.cashfree.com/links/abc — **₹880**")).toBe("Link: — ₹880");
  });

  it("caps long replies at a sentence end", () => {
    const text = "Ek baat. ".repeat(400);
    const spoken = speakableText(text);
    expect(spoken.length).toBeLessThanOrEqual(2500);
    expect(spoken.endsWith(".")).toBe(true);
  });
});
