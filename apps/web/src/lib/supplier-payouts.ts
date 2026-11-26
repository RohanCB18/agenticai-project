import "server-only";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLink, LINK_STATUS, type LinkStatus, paidOnLinkOrders } from "@/lib/cashfree";
import { createTransfer, getTransfer, type PayoutEvent, type PayoutStatus, transferEvent } from "@/lib/cashfree-payouts";
import { notifyOwner } from "@/lib/payments";

// Recording how a supplier payment ended. Two ways to pay: Cashfree Payouts (primary: from the
// shop's Cashfree balance, nothing for the owner to do after "haan") and Easy Split (fallback: a
// page the owner pays, settled to the supplier). The webhooks and Munshi's own status checks can
// all report the same payment: settle_supplier_payout records it once, writes the ledger entry
// once, and says whether anything changed, so the owner is told once.

export type { PayoutEvent, PayoutStatus };
export type Provider = "payouts" | "easy_split";

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

// Cashfree's reasons that the owner, not the supplier, has to fix, in words they can act on.
const OWNER_FIXES: Record<string, string> = {
  ERROR_SELECTING_FUND_SOURCE: "Cashfree couldn't pick an account to pay from: the Payouts keys must come from the account that holds the wallet",
  INSUFFICIENT_BALANCE: "not enough money in your Cashfree Payouts balance",
};

/** What to tell the owner when a supplier payment is made, fails or comes back. Null while waiting. */
export function payoutNotice(
  settled: Pick<Settled, "supplier_name" | "amount_paise" | "status">,
  details: { utr: string | null; description: string | null; statusCode?: string | null },
  provider: Provider,
) {
  const who = settled.supplier_name ?? "your supplier";
  const amount = formatINR(settled.amount_paise);
  const why = (details.statusCode && OWNER_FIXES[details.statusCode]) || details.description;
  const balance = provider === "payouts";
  switch (settled.status) {
    case "success":
      return balance
        ? `✅ Paid ${who} ${amount} from your Cashfree balance.${details.utr ? ` UTR ${details.utr}.` : ""}`
        : `✅ Paid ${who} ${amount}. Cashfree sends it to their account at its next settlement.`;
    case "failed":
      return balance
        ? `❌ The ${amount} payment to ${who} failed${why ? ` (${why})` : ""}. Nothing was paid; the money stays in your Cashfree balance. Say "${who} ko payment kar do" to pay with a payment page instead.`
        : `❌ The ${amount} payment to ${who} wasn't made${why ? ` (${why})` : ""}. Nothing was paid.`;
    case "reversed":
      return `↩️ ${who}'s bank sent back the ${amount} payment${balance ? "; it is back in your Cashfree balance" : ""}. The khata still shows it as paid, so tell me if you pay them another way.`;
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
  await record(admin, event, "easy_split");
  return true;
}

/** Settles one report and tells the owner if it changed anything. */
export async function record(admin: SupabaseClient, event: PayoutEvent, provider: Provider) {
  const settled = await settlePayout(admin, event);
  const notice = settled?.changed ? payoutNotice(settled, event, provider) : null;
  if (notice) await notifyOwner(admin, settled!.merchant_id, notice);
  return settled;
}

/** Payments still waiting after this long aren't checked any more: links have expired, transfers settled. */
const LOOK_BACK_MS = 7 * 24 * 60 * 60_000;
/** Cashfree answers at once, so a transfer or link it has no record of by now was never made. */
const NEVER_MADE_AFTER_MS = 10 * 60_000;

/** What Cashfree says about one waiting payment, or null while it is still on its way. */
async function lookUp(row: { transfer_id: string; amount_paise: number; provider: Provider }): Promise<PayoutEvent | null> {
  if (row.provider === "payouts") {
    const event = { ...transferEvent(await getTransfer(row.transfer_id)), transferId: row.transfer_id };
    return event.status === "pending" ? null : event;
  }
  // A link's own status can stay EXPIRED after a payment, so its orders say what was paid.
  const [link, paid] = await Promise.all([getLink(row.transfer_id), paidOnLinkOrders(row.transfer_id)]);
  return linkOutcome(row.transfer_id, LINK_STATUS[link.link_status] ?? "active", paid, Number(row.amount_paise));
}

/**
 * Asks Cashfree about this shop's supplier payments still waiting (transfers on their way, pages
 * not yet paid), records any that ended and tells the owner, as the webhooks would. Live, a payout
 * was taken (RECEIVED), rejected a second later, and no webhook came: Munshi kept saying "on its
 * way". Returns how many are still waiting.
 */
export async function reconcilePayouts(admin: SupabaseClient, merchantId: string, now = Date.now(), only?: Provider): Promise<number> {
  let query = admin
    .from("supplier_payouts")
    .select("transfer_id, amount_paise, provider, created_at")
    .eq("merchant_id", merchantId)
    .eq("status", "pending")
    .gte("created_at", new Date(now - LOOK_BACK_MS).toISOString());
  if (only) query = query.eq("provider", only);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(10);
  if (error) throw new Error(`Read pending supplier payments failed: ${error.message}`);

  let waiting = 0;
  for (const row of (data ?? []) as { transfer_id: string; amount_paise: number; provider: Provider; created_at: string }[]) {
    let event: PayoutEvent | null;
    try {
      event = await lookUp(row);
    } catch (lookup) {
      const unknown = lookup instanceof Error && /\(404\)/.test(lookup.message);
      if (!unknown || now - Date.parse(row.created_at) < NEVER_MADE_AFTER_MS) {
        if (!unknown) console.warn(`[munshi] supplier payment ${row.transfer_id} status check failed:`, lookup instanceof Error ? lookup.message : lookup);
        waiting++;
        continue;
      }
      event = { transferId: row.transfer_id, cfTransferId: null, status: "failed", statusCode: null, description: "Cashfree has no record of this payment", utr: null };
    }
    if (!event) {
      waiting++;
      continue;
    }
    console.info(`[munshi] supplier payment ${row.transfer_id} (${row.provider}) checked with Cashfree: ${event.status} (${event.statusCode ?? "-"})`);
    await record(admin, event, row.provider);
  }
  return waiting;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a balance payment wasn't made, in words the owner can act on. */
export function whyNotPaid(event: Pick<PayoutEvent, "statusCode" | "description">) {
  return (event.statusCode && OWNER_FIXES[event.statusCode]) || event.description || "Cashfree didn't make the transfer";
}

/** Cashfree's error from a refused call: its code and message, out of "...failed (422): {json}". */
function refusal(error: unknown): { status: number; code: string | null; message: string } | null {
  const text = error instanceof Error ? error.message : String(error);
  const match = /failed \((\d{3})\): ([\s\S]*)$/.exec(text);
  if (!match) return null;
  let body: { code?: string; message?: string } = {};
  try {
    body = JSON.parse(match[2]!) as typeof body;
  } catch {
    // not JSON: keep the text
  }
  return { status: Number(match[1]), code: body.code ? body.code.toUpperCase() : null, message: (body.message ?? match[2]!).slice(0, 160) };
}

type TransferInput = Parameters<typeof createTransfer>[0];

/**
 * Pays a supplier from the shop's Cashfree balance and waits a few seconds for Cashfree to say how
 * it went, so the owner usually hears "paid" in the same reply. A transfer Cashfree refused
 * outright (a 4xx) was never made; one whose answer was lost (a timeout, a 5xx) is looked up, and
 * stays pending if that fails too, never "failed": it may have been made, so paying again another
 * way could pay twice.
 */
export async function sendFromBalance(
  input: TransferInput,
  { create = createTransfer, get = getTransfer, sleep = pause, waitMs = 8_000, everyMs = 2_000 }: { create?: typeof createTransfer; get?: typeof getTransfer; sleep?: (ms: number) => Promise<void>; waitMs?: number; everyMs?: number } = {},
): Promise<PayoutEvent> {
  const id = input.transferId;
  const asked = async () => ({ ...transferEvent(await get(id)), transferId: id });
  const failed = (statusCode: string | null, description: string): PayoutEvent => ({ transferId: id, cfTransferId: null, status: "failed", statusCode, description, utr: null });
  const pending: PayoutEvent = { transferId: id, cfTransferId: null, status: "pending", statusCode: null, description: null, utr: null };

  let event: PayoutEvent;
  try {
    event = { ...transferEvent(await create(input)), transferId: id };
  } catch (error) {
    const refused = refusal(error);
    if (refused && refused.status >= 400 && refused.status < 500 && refused.status !== 409) return failed(refused.code, refused.message);
    try {
      event = await asked();
    } catch (lookup) {
      // Cashfree has no transfer with this id: it never took it.
      return refusal(lookup)?.status === 404 ? failed(null, "Cashfree didn't take the transfer") : pending;
    }
  }
  for (let waited = 0; event.status === "pending" && waited < waitMs; waited += everyMs) {
    await sleep(everyMs);
    try {
      event = await asked();
    } catch {
      break; // the webhook and the next check will say
    }
  }
  return event;
}

/**
 * After a turn that may have started a transfer from the balance: checks those still on their way
 * every few seconds until none is or the time is up, so the owner hears "Paid" within seconds even
 * without the webhook. With nothing on its way it is one quick read. True once none is waiting.
 */
export async function watchPayouts(admin: SupabaseClient, merchantId: string, { forMs, everyMs = 4_000, sleep = pause }: { forMs: number; everyMs?: number; sleep?: (ms: number) => Promise<void> }) {
  for (let waited = 0; ; waited += everyMs) {
    if ((await reconcilePayouts(admin, merchantId, Date.now(), "payouts")) === 0) return true;
    if (waited + everyMs > forMs) return false;
    await sleep(everyMs);
  }
}
