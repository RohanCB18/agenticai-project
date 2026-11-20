import "server-only";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PayoutEvent, PayoutStatus } from "@/lib/cashfree-payouts";

// Recording what Cashfree says about a supplier payout. The payout tool (when Cashfree answers at
// once) and the webhook (later) can both report the same transfer: settle_supplier_payout records
// it once, writes the ledger entry once, and says whether anything changed.

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

/** What to tell the owner when a payout lands, fails or comes back. Null while it is on its way. */
export function payoutNotice(settled: Pick<Settled, "supplier_name" | "amount_paise" | "status">, details: { utr: string | null; description: string | null }) {
  const who = settled.supplier_name ?? "your supplier";
  const amount = formatINR(settled.amount_paise);
  switch (settled.status) {
    case "success":
      return `✅ Paid ${who} ${amount}.${details.utr ? ` UTR ${details.utr}.` : ""}`;
    case "failed":
      return `❌ The ${amount} payment to ${who} failed${details.description ? ` (${details.description})` : ""}. The money stays in your Cashfree balance.`;
    case "reversed":
      return `↩️ ${who}'s bank sent back the ${amount} payment. It is back in your Cashfree balance; the khata still shows it as paid, so tell me if you pay them another way.`;
    default:
      return null;
  }
}
