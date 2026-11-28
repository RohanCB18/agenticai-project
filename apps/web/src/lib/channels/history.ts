import "server-only";
import { trimThread } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import type { MessagingChannel } from "./types";

/**
 * Adds what Munshi said on its own to the chat's history: a new online order, a restock ask, the
 * answer to a Haan tap. Without it the agent never saw them, and live the owner's "haan" to a
 * restock notice got "Theek hai, aur kya chahiye?", and "pay kar diya?" was answered from a
 * payment days old. `owner` is what the owner typed, when that was the answer (a typed "haan").
 *
 * The thread's updated_at is left alone: it marks Munshi's last reply in a conversation turn,
 * which is how a typed "haan" knows whether a restock ask came after it. A chat with no thread yet
 * gets one dated at the start of time, for the same reason. Never throws: losing this costs
 * context, not the message, which was already sent.
 */
export async function rememberInThread(admin: SupabaseClient, merchantId: string, channel: MessagingChannel, said: { munshi: string; owner?: string }) {
  try {
    const added: ModelMessage[] = [...(said.owner ? [{ role: "user" as const, content: said.owner }] : []), { role: "assistant", content: said.munshi }];
    const { data } = await admin.from("agent_threads").select("messages").eq("merchant_id", merchantId).eq("channel", channel).maybeSingle();
    if (data) {
      const messages = trimThread([...((data.messages ?? []) as ModelMessage[]), ...added]);
      await admin.from("agent_threads").update({ messages }).eq("merchant_id", merchantId).eq("channel", channel);
    } else {
      await admin.from("agent_threads").insert({ merchant_id: merchantId, channel, messages: added, updated_at: new Date(0).toISOString() });
    }
  } catch (error) {
    console.error("[munshi] couldn't add a message to the chat history:", error instanceof Error ? error.message : error);
  }
}
