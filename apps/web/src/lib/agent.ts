import "server-only";
import { type Channel, createKhataAgent, detectLanguage, resolveModel, type Route } from "@munshi/agents";
import type { Language } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseKhataStore } from "@/lib/khata-store";
import { start } from "workflow/api";
import { browserConfigured } from "@/lib/browser";
import { configuredChartRunner } from "@/lib/charts";
import { gstPortalLookup } from "@/workflows/gst-portal";
import { configuredKnowledge } from "@/lib/knowledge";
import { configuredSupplier } from "@/lib/supplier";

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
  extraNote?: string;
  onRoute?: (route: Route) => void;
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
    extraNote: opts.extraNote,
    // MUNSHI_SPECIALISTS=off goes back to one agent with every tool, without a deploy of code.
    specialists: process.env.MUNSHI_SPECIALISTS !== "off",
    onRoute: (route) => {
      console.info(`[munshi] ${opts.source} message -> ${route.desk} desk (${route.by}, ${route.ms}ms)`);
      opts.onRoute?.(route);
    },
    detectLanguage: sarvamApiKey ? (text) => detectLanguage({ apiKey: sarvamApiKey, text }) : undefined,
    // The wholesaler's A2A agent, when DISTRIBUTOR_URL is set.
    supplier: configuredSupplier(),
    // Official GST rates to answer from, when SUPABASE_EMBED_KEY is set.
    knowledge: configuredKnowledge(),
    // Charts drawn in a Vercel Sandbox, when CHART_SANDBOX_SNAPSHOT is set.
    charts: configuredChartRunner(),
    // GST portal lookups in a sandboxed browser, run as a background workflow.
    portal: browserConfigured()
      ? {
          start: async (question: string) => {
            // The answer is sent on a linked chat app; with none, there is nowhere to send it.
            const { count } = await opts.db.from("channel_links").select("channel", { count: "exact", head: true }).eq("merchant_id", opts.merchant.id);
            if (!count) return "no_inbox" as const;
            await start(gstPortalLookup, [{ merchantId: opts.merchant.id, question }]);
          },
        }
      : undefined,
  });
}
