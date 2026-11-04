"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_RECORDING_MS = 28_000; // Saaras REST takes clips under 30 seconds

export type VoiceState = "idle" | "recording" | "transcribing" | "speaking";

function pickMimeType() {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

async function errorText(res: Response, fallback: string) {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

/**
 * Push-to-talk: record → /api/voice/transcribe (Saaras), and speak replies via /api/voice/speak (Bulbul).
 */
export function useVoice(onTranscript: (text: string, languageCode: string | null) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  });

  const stopSpeaking = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setState((s) => (s === "speaking" ? "idle" : s));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    stopSpeaking();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Allow microphone access to talk to Munshi.");
      return;
    }

    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timer.current) clearTimeout(timer.current);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 1000) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const form = new FormData();
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        form.append("audio", blob, `speech.${ext}`);
        const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
        if (!res.ok) throw new Error(await errorText(res, "Couldn't hear that. Try again."));
        const { transcript, languageCode } = (await res.json()) as { transcript: string; languageCode: string | null };
        if (!transcript) throw new Error("Didn't catch anything. Try again, a little closer to the mic.");
        onTranscriptRef.current(transcript, languageCode);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't hear that.");
      } finally {
        setState((s) => (s === "transcribing" ? "idle" : s));
      }
    };

    recorder.current = rec;
    rec.start();
    setState("recording");
    timer.current = setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORDING_MS);
  }, [stopSpeaking]);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const speak = useCallback(async (text: string, languageCode: string | null) => {
    try {
      const res = await fetch("/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, languageCode }),
      });
      if (!res.ok) throw new Error(await errorText(res, "Couldn't speak the reply."));
      const url = URL.createObjectURL(await res.blob());
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => {
        URL.revokeObjectURL(url);
        if (audio.current === player) stopSpeaking();
      };
      setState("speaking");
      await player.play();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't speak the reply.");
      setState((s) => (s === "speaking" ? "idle" : s));
    }
  }, [stopSpeaking]);

  useEffect(
    () => () => {
      if (recorder.current?.state === "recording") recorder.current.stop();
      audio.current?.pause();
    },
    [],
  );

  return { state, error, start, stop, speak, stopSpeaking };
}
