"use client";

import type { KhataUIMessage } from "@munshi/agents";
import { completedActionsInParts, type MessagePart, NOT_RECORDED, type ReplyFooter, replyFooter } from "@munshi/agents/receipts";

const textOf = (message: KhataUIMessage) =>
  message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();

/**
 * What Telegram adds under a reply, for the web chat: receipts read from the tools' own results,
 * then at most one warning. The owner's words are the latest message they sent before this reply.
 */
export function footerFor(messages: KhataUIMessage[], index: number, finished: boolean): ReplyFooter {
  const message = messages[index];
  const parts = message.parts as readonly MessagePart[];
  const owner = messages.slice(0, index).findLast((m) => m.role === "user");
  const footer = replyFooter({
    ownerText: owner ? textOf(owner) : "",
    reply: textOf(message),
    actions: completedActionsInParts(parts),
    // Approved but not yet carried out still counts as waiting: the continuation is on its way.
    awaitingApproval: parts.some((part) => part.state === "approval-requested" || part.state === "approval-responded"),
  });
  // A warning waits for the end of the turn: a later step may still save the entry.
  return finished ? footer : { ...footer, notice: null };
}

export function ReplyFooterView({ footer }: { footer: ReplyFooter }) {
  return (
    <>
      {footer.receipts.length > 0 && (
        <div role="group" aria-label="Saved" className="flex max-w-sm flex-col gap-0.5 rounded-lg border border-dashed border-line px-4 py-2 text-sm">
          {footer.receipts.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {footer.notice && (
        <p
          role="status"
          className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${footer.notice === NOT_RECORDED ? "border border-line text-muted" : "bg-danger-soft text-danger"}`}
        >
          {footer.notice}
        </p>
      )}
    </>
  );
}
