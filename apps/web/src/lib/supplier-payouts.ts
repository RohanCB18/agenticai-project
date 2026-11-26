import "server-only";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLink, LINK_STATUS, type LinkStatus, paidOnLinkOrders } from "@/lib/cashfree";
import { notifyOwner } from "@/lib/payments";

// Paying suppliers with Cashfree Easy Split. The owner pays a Cashfree payment link split to the
// supplier (a vendor); Cashfree settles that amount to the supplier's account. The webhook and
// Munshi's own status checks can both report the same link: settle_supplier_payout records it
// once, writes the ledger entry once, and says whether anything changed, so the owner is told once.

export type PayoutStatus = "pending" | "success" | "failed" | "reversed";

/** One report about a supplier payment. transferId is Munshi's id for it: the payment link's id. */
export type PayoutEvent = { transferId: string; cfTransferId: string | null; status: PayoutStatus; statusCode: string | null; description: string | null; utr: string | null };

export type Settled = { merchant_id: string; supplier_id: string; supplier_name: string | null; amount_paise: number; status: PayoutStatus; changed: boolean };

export async function settlePayout(admin: SupabaseClient, event: PayoutEvent): Promise<Settled | null> {
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

/** What to tell the owner when a supplier payment is made, or its page lapses unpaid. Null while waiting. */
export function payoutNotice(settled: Pick<Settled, "supplier_name" | "amount_paise" | "status">, details: { utr: string | null; description: string | null }) {
  const who = settled.supplier_name ?? "your supplier";
  const amount = formatINR(settled.amount_paise);
  switch (settled.status) {
    case "success":
      return `✅ Paid ${who} ${amount}. Cashfree sends it to their account at its next settlement.${details.utr ? ` Ref ${details.utr}.` : ""}`;
    case "failed":
      return `❌ The ${amount} payment to ${who} wasn't made${details.description ? ` (${details.description})` : ""}. Nothing was paid.`;
    case "reversed":
      return `↩️ The ${amount} payment to ${who} was returned. The khata still shows it as paid, so tell me if you pay them another way.`;
    default:
      return null;
  }
}

/** "UPI su•••@upi" or "bank ••••1191": where the money goes, without showing all of it. */
export function maskedAccount(supplier: { payout_vpa: string | null; payout_account_last4: string | null }) {
  if (supplier.payout_vpa) {
    const [user = "", host = ""] = supplier.payout_vpa.split("@");
    return `UPI ${user.slice(0, 2)}•••@${host}`;
  }
  return supplier.payout_account_last4 ? `bank ••••${supplier.payout_account_last4}` : null;
}

/**
 * Where a supplier's payment link stands. Paid in full is a payment; a link that expired or was
 * cancelled with nothing paid is a payment that wasn't made; anything else is still waiting.
 */
export function linkOutcome(linkId: string, status: LinkStatus, paidPaise: number, amountPaise: number): PayoutEvent | null {
  const base = { transferId: linkId, cfTransferId: null, statusCode: status.toUpperCase(), utr: null };
  if (paidPaise >= amountPaise || status === "paid") return { ...base, status: "success", description: null };
  if ((status === "expired" || status === "cancelled") && paidPaise === 0) {
    return { ...base, status: "failed", description: status === "expired" ? "the payment page expired unpaid" : "the payment page was cancelled" };
  }
  return null;
}

/**
 * The Cashfree payments webhook for a link that isn't a customer's: if it is a supplier payment,
 * record it and tell the owner. False if the link isn't one of Munshi's supplier payments.
 */
export async function settleSupplierLink(admin: SupabaseClient, linkId: string, status: LinkStatus, paidPaise: number): Promise<boolean> {
  const { data: row } = await admin.from("supplier_payouts").select("amount_paise").eq("transfer_id", linkId).eq("provider", "easy_split").maybeSingle();
  if (!row) return false;
  const event = linkOutcome(linkId, status, paidPaise, Number(row.amount_paise));
  if (!event) return true;
  const settled = await settlePayout(admin, event);
  const notice = settled?.changed ? payoutNotice(settled, event) : null;
  if (notice) await notifyOwner(admin, settled!.merchant_id, notice);
  return true;
}

/** Supplier payments still waiting after this long aren't checked any more: their links have expired. */
const LOOK_BACK_MS = 7 * 24 * 60 * 60_000;
/** Cashfree makes a link at once, so one it has no record of by now was never made. */
const NEVER_MADE_AFTER_MS = 10 * 60_000;

/**
 * Asks Cashfree about this shop's supplier payment links still waiting, records any paid (or lapsed
 * unpaid) and tells the owner, as the webhook would. Live, a Cashfree payout was rejected a second
 * after it was taken and no webhook ever came: Munshi kept saying "on its way". Returns how many are
 * still waiting. Payouts made through Cashfree Payouts, before Easy Split, are left alone.
 */
export async function reconcilePayouts(admin: SupabaseClient, merchantId: string, now = Date.now()): Promise<number> {
  const { data, error } = await admin
    .from("supplier_payouts")
    .select("transfer_id, amount_paise, created_at")
    .eq("merchant_id", merchantId)
    .eq("provider", "easy_split")
    .eq("status", "pending")
    .gte("created_at", new Date(now - LOOK_BACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(`Read pending supplier payments failed: ${error.message}`);

  let waiting = 0;
  for (const row of (data ?? []) as { transfer_id: string; amount_paise: number; created_at: string }[]) {
    let event: PayoutEvent | null;
    try {
      // A link's own status can stay EXPIRED after a payment, so its orders say what was paid.
      const [link, paid] = await Promise.all([getLink(row.transfer_id), paidOnLinkOrders(row.transfer_id)]);
      event = linkOutcome(row.transfer_id, LINK_STATUS[link.link_status] ?? "active", paid, Number(row.amount_paise));
    } catch (lookup) {
      const unknown = lookup instanceof Error && /\(404\)/.test(lookup.message);
      if (!unknown || now - Date.parse(row.created_at) < NEVER_MADE_AFTER_MS) {
        if (!unknown) console.warn(`[munshi] supplier payment ${row.transfer_id} status check failed:`, lookup instanceof Error ? lookup.message : lookup);
        waiting++;
        continue;
      }
      event = { transferId: row.transfer_id, cfTransferId: null, status: "failed", statusCode: null, description: "Cashfree has no record of this payment page", utr: null };
    }
    if (!event) {
      waiting++;
      continue;
    }
    console.info(`[munshi] supplier payment ${row.transfer_id} checked with Cashfree: ${event.status} (${event.statusCode ?? "-"})`);
    const settled = await settlePayout(admin, event);
    const notice = settled?.changed ? payoutNotice(settled, event) : null;
    if (notice) await notifyOwner(admin, settled!.merchant_id, notice);
  }
  return waiting;
}
