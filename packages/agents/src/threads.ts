import type { ModelMessage } from "ai";

// Conversation threads for channels with no browser to hold the history (WhatsApp, phone).
// The server stores the AI SDK model messages and replays them on each new message.

export type PendingApproval = { approvalId: string; toolCallId: string; toolName: string; input: unknown };

/** Approval requests the owner hasn't answered yet, oldest first. */
export function pendingApprovals(messages: ModelMessage[]): PendingApproval[] {
  const calls = new Map<string, { toolName: string; input: unknown }>();
  const requested: { approvalId: string; toolCallId: string }[] = [];
  const answered = new Set<string>();

  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
      else if (part.type === "tool-approval-request" && !part.isAutomatic) requested.push({ approvalId: part.approvalId, toolCallId: part.toolCallId });
      else if (part.type === "tool-approval-response") answered.add(part.approvalId);
    }
  }

  return requested
    .filter((r) => !answered.has(r.approvalId))
    .map((r) => ({ ...r, toolName: calls.get(r.toolCallId)?.toolName ?? "unknown", input: calls.get(r.toolCallId)?.input }));
}

/** The owner's answer to one approval, as the tool message the agent expects next. */
export function approvalResponse(approvalId: string, approved: boolean, reason?: string): ModelMessage {
  return { role: "tool", content: [{ type: "tool-approval-response", approvalId, approved, ...(reason ? { reason } : {}) }] };
}

/**
 * Before a new owner message, closes approvals they moved on from: an unanswered request
 * is denied, so the agent never runs it later and the history stays valid.
 */
export function closePendingApprovals(messages: ModelMessage[]): ModelMessage[] {
  const pending = pendingApprovals(messages);
  if (pending.length === 0) return messages;
  return [
    ...messages,
    {
      role: "tool",
      content: pending.map((p) => ({
        type: "tool-approval-response" as const,
        approvalId: p.approvalId,
        approved: false,
        reason: "The owner sent a new message instead of approving.",
      })),
    },
  ];
}

/**
 * JSON outputs of one tool in these messages. Read messages rather than `steps[].toolResults`:
 * a tool run right after an approval executes before the first step, so it isn't in `steps`.
 */
export function toolOutputs(messages: ModelMessage[], toolName: string): unknown[] {
  const outputs: unknown[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === toolName && part.output.type === "json") outputs.push(part.output.value);
    }
  }
  return outputs;
}

const OLD_RESULT = "Earlier result, no longer current. Call the tool again for today's figures.";

/**
 * Blanks tool results from before the owner's latest message. Balances and stock change between
 * messages (bills, payments, other channels), and in testing the model repeated old figures instead
 * of calling the tool again. Calls and their inputs stay, so "uska total?" still knows who "uska" is.
 * A question the owner was asked ("is this a repeat?") stays: their answer only means something
 * next to it, and the tools check it before recording.
 */
export function forgetOldToolResults(messages: ModelMessage[]): ModelMessage[] {
  let lastOwner = messages.length - 1;
  while (lastOwner >= 0 && messages[lastOwner]!.role !== "user") lastOwner--;
  return messages.map((message, index) => {
    if (index >= lastOwner || message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" && !isOpenQuestion(part.output) ? { ...part, output: { type: "text" as const, value: OLD_RESULT } } : part,
      ),
    };
  });
}

function isOpenQuestion(output: { type: string; value?: unknown }) {
  return output.type === "json" && (output.value as { status?: unknown } | null)?.status === "possible_repeat";
}

/**
 * True when the owner was asked about this exact repeat before their latest message, so a
 * "yes, it's new" from them can be trusted. A model setting confirmedNew on its own can't be:
 * in testing it did, and the same payment was saved twice.
 */
export function ownerWasAskedAboutRepeat(messages: ModelMessage[], customer: string, amount: string): boolean {
  let lastOwner = messages.length - 1;
  while (lastOwner >= 0 && messages[lastOwner]!.role !== "user") lastOwner--;
  return messages.slice(0, Math.max(lastOwner, 0)).some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => {
        if (part.type !== "tool-result" || part.output.type !== "json") return false;
        const value = part.output.value as { status?: unknown; customer?: unknown; amount?: unknown } | null;
        return value?.status === "possible_repeat" && value.customer === customer && value.amount === amount;
      }),
  );
}

/** Keeps roughly the last `max` messages, always starting at an owner message so tool calls stay paired. */
export function trimThread(messages: ModelMessage[], max = 40): ModelMessage[] {
  if (messages.length <= max) return messages;
  for (let i = messages.length - max; i < messages.length; i++) {
    if (messages[i]!.role === "user") return messages.slice(i);
  }
  return messages.slice(-1);
}
