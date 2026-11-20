import type { BrowseResult } from "@munshi/agents";

// A GST portal lookup as a durable workflow: the browsing takes about a minute, longer than a chat
// turn, so the chat answers at once ("checking the portal") and this run browses, keeps the result
// in the audit log, and messages the owner. Steps import app code dynamically, as in the reminders
// workflow, to keep the sandbox, Sarvam and Supabase code out of the workflow body.

export type PortalLookupInput = { merchantId: string; question: string };

export async function gstPortalLookup({ merchantId, question }: PortalLookupInput): Promise<BrowseResult> {
  "use workflow";
  const result = await browse(question);
  await report(merchantId, question, result);
  return result;
}

async function browse(question: string): Promise<BrowseResult> {
  "use step";
  const { lookUpOnGstPortal } = await import("@/lib/browser");
  try {
    return await lookUpOnGstPortal(question);
  } catch (error) {
    // Reported, not retried: a second sandbox and browsing run costs as much as the first.
    console.error("[munshi] GST portal lookup failed:", error instanceof Error ? error.message : error);
    return { found: false, answer: "The GST portal couldn't be checked just now.", source: null, steps: 0 };
  }
}

async function report(merchantId: string, question: string, result: BrowseResult) {
  "use step";
  const [{ createAdminClient }, { notifyOwner }, { portalNotice }] = await Promise.all([
    import("@/lib/supabase/admin"),
    import("@/lib/payments"),
    import("@munshi/agents"),
  ]);
  const db = createAdminClient();
  await db.from("audit_log").insert({ merchant_id: merchantId, actor: "browser-agent", action: "gst_portal_lookup", details: { question, ...result } });
  await notifyOwner(db, merchantId, portalNotice(question, result));
}
