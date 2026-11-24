import "server-only";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTransfer, type PayoutEvent, type PayoutStatus, transferEvent } from "@/lib/cashfree-payouts";
import { notifyOwner } from "@/lib/payments";

// Recording what Cashfree says about a supplier payout. The payout tool (when Cashfree answers at
// once), the webhook (later) and Munshi's own status checks can all report the same transfer:
// settle_supplier_payout records it once, writes the ledger entry once, and says whether anything
// changed, so the owner is told once.

export type Settled = { merchant_id: string; supplier_id: string; supplier_name: string | null; amount_paise: number; status: PayoutStatus; changed: boolean };

export async function settlePayout(admin: SupabaseClient, event: Omit<PayoutEvent, "transferId"> & { transferId: string }): Promise<Settled | null> {
  const { data, error } = await admin.rpc("settle_supplier_payout", {
    p_transfer_id: event.transferId,
    p_status: event.status,
    p_status_code: event.statusCode,
    p_status_description: event.description,
    p_utr: event.utr,
    p_cf_transfer_id: event.cfTransferId,
  });
  if (error) throw new Error(`Settle payout failed: ${error.message}`);
  const row = (data as Settled[] | null)?.[0];
  return row ? { ...row, amount_paise: Number(row.amount_paise) } : null;
}

// Cashfree's reasons that the owner, not the supplier, has to fix, in words they can act on.
const OWNER_FIXES: Record<string, string> = {
  ERROR_SELECTING_FUND_SOURCE: "Cashfree couldn't pick an account to pay from: check Fund Sources in your Cashfree Payouts dashboard",
  INSUFFICIENT_BALANCE: "not enough money in your Cashfree Payouts balance",
};

/** What to tell the owner when a payout lands, fails or comes back. Null while it is on its way. */
export function payoutNotice(
  settled: Pick<Settled, "supplier_name" | "amount_paise" | "status">,
  details: { utr: string | null; description: string | null; statusCode?: string | null },
) {
  const who = settled.supplier_name ?? "your supplier";
  const amount = formatINR(settled.amount_paise);
  const why = (details.statusCode && OWNER_FIXES[details.statusCode]) || details.description;
  switch (settled.status) {
    case "success":
      return `✅ Paid ${who} ${amount}.${details.utr ? ` UTR ${details.utr}.` : ""}`;
    case "failed":
      return `❌ The ${amount} payment to ${who} failed${why ? ` (${why})` : ""}. Nothing was paid; the money stays in your Cashfree balance.`;
    case "reversed":
      return `↩️ ${who}'s bank sent back the ${amount} payment. It is back in your Cashfree balance; the khata still shows it as paid, so tell me if you pay them another way.`;
    default:
      return null;
  }
}

/** Payouts still "on its way" after this long aren't checked any more: the dashboard shows them. */
const LOOK_BACK_MS = 7 * 24 * 60 * 60_000;
/** Cashfree answers a transfer request at once, so one it has no record of by now was never made. */
const NEVER_MADE_AFTER_MS = 10 * 60_000;

/**
 * Asks Cashfree about this shop's supplier payouts still on their way, records any that finished
 * and tells the owner, as the webhook would. Live, Cashfree took a ₹3,900 transfer (RECEIVED),
 * rejected it a second later, and no webhook ever came: Munshi kept saying "on its way". Returns
 * how many are still on their way.
 */
export async function reconcilePayouts(admin: SupabaseClient, merchantId: string, now = Date.now()): Promise<number> {
  const { data, error } = await admin
    .from("supplier_payouts")
    .select("transfer_id, created_at")
    .eq("merchant_id", merchantId)
    .eq("status", "pending")
    .gte("created_at", new Date(now - LOOK_BACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`Read pending payouts failed: ${error.message}`);

  let stillPending = 0;
  for (const row of (data ?? []) as { transfer_id: string; created_at: string }[]) {
    let event: PayoutEvent;
    try {
      event = { ...transferEvent(await getTransfer(row.transfer_id)), transferId: row.transfer_id };
    } catch (lookup) {
      const unknown = lookup instanceof Error && /\(404\)/.test(lookup.message);
      if (!unknown || now - Date.parse(row.created_at) < NEVER_MADE_AFTER_MS) {
        if (!unknown) console.warn(`[munshi] payout ${row.transfer_id} status check failed:`, lookup instanceof Error ? lookup.message : lookup);
        stillPending++;
        continue;
      }
      event = { transferId: row.transfer_id, cfTransferId: null, status: "failed", statusCode: null, description: "Cashfree has no record of this payment", utr: null };
    }
    if (event.status === "pending") {
      stillPending++;
      continue;
    }
    console.info(`[munshi] payout ${row.transfer_id} checked with Cashfree: ${event.status} (${event.statusCode ?? "-"})`);
    const settled = await settlePayout(admin, event);
    const notice = settled?.changed ? payoutNotice(settled, event) : null;
    if (notice) await notifyOwner(admin, settled!.merchant_id, notice);
  }
  return stillPending;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Right after a payout starts: checks with Cashfree every few seconds until nothing is on its way
 * or the time is up, so the owner hears whether it landed without waiting on the webhook.
 */
export async function watchPayouts(admin: SupabaseClient, merchantId: string, { forMs, everyMs = 4_000, sleep = pause }: { forMs: number; everyMs?: number; sleep?: (ms: number) => Promise<void> }) {
  for (let waited = everyMs; waited <= forMs; waited += everyMs) {
    await sleep(everyMs);
    if ((await reconcilePayouts(admin, merchantId)) === 0) return true;
  }
  return false;
}
