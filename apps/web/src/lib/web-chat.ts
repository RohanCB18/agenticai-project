import "server-only";
import type { KhataUIMessage } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";

// The web chat's saved conversation (web_chat_threads): loaded when the chat opens, saved after
// every reply. A failure here never stops the chat; at worst a refresh starts it fresh.

/** How many messages a thread keeps. Older ones drop off, as Telegram's thread trims too. */
export const WEB_CHAT_KEEP = 40;

/** The latest messages, starting at an owner's message so no reply is cut from its question. */
export function keepRecent<T extends { role: string }>(messages: T[], keep = WEB_CHAT_KEEP): T[] {
  if (messages.length <= keep) return messages;
  const recent = messages.slice(-keep);
  const firstOwner = recent.findIndex((m) => m.role === "user");
  return firstOwner > 0 ? recent.slice(firstOwner) : recent;
}

export async function loadWebChat(db: SupabaseClient, merchantId: string): Promise<KhataUIMessage[]> {
  const { data, error } = await db.from("web_chat_threads").select("messages").eq("merchant_id", merchantId).maybeSingle();
  if (error) {
    console.warn("[munshi] couldn't load the web chat:", error.message);
    return [];
  }
  return Array.isArray(data?.messages) ? (data.messages as KhataUIMessage[]) : [];
}

export async function saveWebChat(db: SupabaseClient, merchantId: string, messages: KhataUIMessage[]) {
  const { error } = await db
    .from("web_chat_threads")
    .upsert({ merchant_id: merchantId, messages: keepRecent(messages), updated_at: new Date().toISOString() });
  if (error) console.warn("[munshi] couldn't save the web chat:", error.message);
}

export async function clearWebChat(db: SupabaseClient, merchantId: string) {
  const { error } = await db.from("web_chat_threads").delete().eq("merchant_id", merchantId);
  if (error) console.warn("[munshi] couldn't clear the web chat:", error.message);
}

/**
 * An approval left unanswered in an earlier message (the owner typed something else instead) is
 * closed as declined, as closePendingApprovals does for Telegram: a tool call with no result breaks
 * the next run. Only the latest message may still be waiting for its button.
 */
export function closeStaleApprovals(messages: KhataUIMessage[]): KhataUIMessage[] {
  return messages.map((message, i) => {
    if (i === messages.length - 1 || !message.parts.some((part) => "state" in part && part.state === "approval-requested")) return message;
    return {
      ...message,
      parts: message.parts.map((part) =>
        "state" in part && part.state === "approval-requested"
          ? ({ ...part, state: "output-denied", approval: { ...part.approval, approved: false, reason: "The owner moved on without answering." } } as unknown as KhataUIMessage["parts"][number])
          : part,
      ),
    };
  });
}

/** "2 steps, tools recordCredit > lookupGst": what a web chat reply did, for the logs (as Telegram logs). */
export function replySummary(message: KhataUIMessage | undefined) {
  const tools = (message?.parts ?? []).flatMap((part) => (part.type.startsWith("tool-") ? [part.type.slice("tool-".length)] : []));
  const steps = (message?.parts ?? []).filter((part) => part.type === "step-start").length;
  return `${steps} step${steps === 1 ? "" : "s"}, tools ${tools.length ? tools.join(" > ") : "none"}`;
}
