"use client";

import { useChat } from "@ai-sdk/react";
import type { KhataUIMessage } from "@munshi/agents";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useEffect, useRef, useState } from "react";
import { ToolPart } from "./tool-part";

const SUGGESTIONS = [
  "Ramesh ne 450 ka saaman liya",
  "ಫಾತಿಮಾ ಎಷ್ಟು ಬಾಕಿ ಇದೆ?",
  "Who owes me money?",
  "Ramesh ko payment link bhejo",
];

export function Chat() {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, addToolApprovalResponse, status, error } = useChat<KhataUIMessage>({
    // After the owner approves or denies, continue the agent automatically.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setInput("");
  }

  return (
    <>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto py-6" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-muted">Try one of these, in any language:</p>
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
          </div>
        ))}

        {status === "submitted" && <p className="text-sm text-muted">Munshi is writing…</p>}
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {readableError(error)}
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
        <label htmlFor="message" className="sr-only">
          Message
        </label>
        <input
          id="message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ramesh took ₹450 on credit…"
          className="flex-1 rounded-md border border-line bg-surface px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
          autoComplete="off"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-md bg-accent px-4 py-2.5 font-medium text-on-accent disabled:opacity-50">
          Send
        </button>
      </form>
    </>
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
