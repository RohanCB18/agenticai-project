"use client";

import { useChat } from "@ai-sdk/react";
import type { KhataUIMessage } from "@munshi/agents";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useEffect, useRef, useState } from "react";
import { ToolPart } from "./tool-part";
import { useVoice } from "./use-voice";

const DESK_LABELS = { khata: "Khata desk", collections: "Collections desk", stock: "Stock desk", general: "Munshi" } as const;

const SUGGESTIONS = [
  "Ramesh ne 450 ka saaman liya",
  "ಫಾತಿಮಾ ಎಷ್ಟು ಬಾಕಿ ಇದೆ?",
  "Who owes me money?",
  "Ramesh ko payment link bhejo",
];

export function Chat() {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // Set while the owner is talking rather than typing: replies are spoken back in this language.
  const voiceLanguage = useRef<string | null | undefined>(undefined);
  // How much of each assistant message has already been spoken, so approval continuations speak only the new part.
  const spoken = useRef<{ id: string; length: number } | null>(null);

  const { messages, sendMessage, addToolApprovalResponse, status, error } = useChat<KhataUIMessage>({
    // After the owner approves or denies, continue the agent automatically.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const busy = status === "submitted" || status === "streaming";

  const voice = useVoice((transcript, languageCode) => {
    voiceLanguage.current = languageCode;
    // The server reads this to tag ledger entries as spoken (approval continuations keep it too).
    sendMessage({ text: transcript, metadata: { source: "voice" } });
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // When a voice turn finishes, speak the reply text that hasn't been spoken yet.
  const { speak } = voice;
  useEffect(() => {
    if (status !== "ready" || voiceLanguage.current === undefined) return;
    const last = messages.at(-1);
    if (last?.role !== "assistant") return;
    const text = last.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim();
    const from = spoken.current?.id === last.id ? spoken.current.length : 0;
    spoken.current = { id: last.id, length: text.length };
    const fresh = text.slice(from).trim();
    if (fresh) speak(fresh, voiceLanguage.current);
  }, [status, messages, speak]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    voiceLanguage.current = undefined; // typing switches spoken replies off
    voice.stopSpeaking();
    sendMessage({ text: trimmed });
    setInput("");
  }

  const recording = voice.state === "recording";
  const micLabel = recording ? "Stop and send" : voice.state === "transcribing" ? "Listening…" : "Talk to Munshi";

  return (
    <>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-6" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">Tap the mic and speak, or try one of these, in any language:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:border-accent">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex flex-col gap-2"}>
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return message.role === "user" ? (
                  <p key={i} className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-4 py-2 text-on-accent">
                    {part.text}
                  </p>
                ) : (
                  <p key={i} className="max-w-[85%] whitespace-pre-wrap">
                    {part.text}
                  </p>
                );
              }
              if (part.type.startsWith("tool-")) {
                return <ToolPart key={i} part={part as never} onDecision={addToolApprovalResponse} />;
              }
              return null;
            })}
            {message.role === "assistant" && message.metadata?.desk && message.metadata.desk !== "general" && (
              <p className="text-xs uppercase tracking-wider text-muted">{DESK_LABELS[message.metadata.desk]}</p>
            )}
          </div>
        ))}

        {status === "submitted" && <p className="text-sm text-muted">Munshi is writing…</p>}
        {voice.state === "speaking" && (
          <button onClick={voice.stopSpeaking} className="self-start text-sm text-muted underline-offset-4 hover:underline">
            Munshi is speaking · Stop
          </button>
        )}
        {(error || voice.error) && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {voice.error ?? readableError(error!)}
          </p>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 border-t border-line py-4"
      >
        <button
          type="button"
          onClick={recording ? voice.stop : voice.start}
          disabled={busy || voice.state === "transcribing"}
          aria-label={micLabel}
          aria-pressed={recording}
          title={micLabel}
          className={`flex size-11 shrink-0 items-center justify-center rounded-full border disabled:opacity-50 ${
            recording ? "animate-pulse border-danger bg-danger text-on-accent" : "border-line bg-surface hover:border-accent"
          }`}
        >
          {recording ? <StopIcon /> : <MicIcon />}
        </button>
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <input
          id="message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={recording ? "Listening… tap ■ when done" : "Ramesh took ₹450 on credit…"}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-md bg-accent px-4 py-2.5 font-medium text-on-accent disabled:opacity-50">
          Send
        </button>
      </form>
    </>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function readableError(error: Error) {
  try {
    const parsed = JSON.parse(error.message) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    // not JSON
  }
  return error.message || "Something went wrong. Try again.";
}
