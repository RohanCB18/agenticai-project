import "server-only";
import { type Channel, createKhataAgent, detectLanguage, resolveModel } from "@munshi/agents";
import type { Language } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseKhataStore } from "@/lib/khata-store";

export class ApprovalSecretMissingError extends Error {
  constructor() {
    super("TOOL_APPROVAL_SECRET is missing. Generate one with `openssl rand -base64 32` and add it to apps/web/.env.local.");
    this.name = "ApprovalSecretMissingError";
  }
}

/**
 * The khata agent for one shop, used by every channel. Throws ApprovalSecretMissingError or
 * MissingModelKeyError when the server isn't configured.
 */
export function buildKhataAgent(opts: {
  db: SupabaseClient;
  merchant: { id: string; shopName: string; language: Language };
  source: "chat" | "voice" | "telegram" | "whatsapp";
  channel?: Channel;
}) {
  // Without this secret a client could forge an "approved" payment in the chat history.
  const approvalSecret = process.env.TOOL_APPROVAL_SECRET;
  if (!approvalSecret) throw new ApprovalSecretMissingError();

  const sarvamApiKey = process.env.SARVAM_API_KEY;
  const model = resolveModel(
    {
      sarvamApiKey,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      fallbackModel: process.env.MUNSHI_FALLBACK_MODEL,
    },
    (error) => console.warn("[munshi] Sarvam failed, falling back to Claude:", error instanceof Error ? error.message : error),
  );

  return createKhataAgent({
    model,
    store: createSupabaseKhataStore(opts.db, opts.merchant.id, { source: opts.source }),
    shopName: opts.merchant.shopName,
    language: opts.merchant.language,
    approvalSecret,
    channel: opts.channel,
    detectLanguage: sarvamApiKey ? (text) => detectLanguage({ apiKey: sarvamApiKey, text }) : undefined,
  });
}
