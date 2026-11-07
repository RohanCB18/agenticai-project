import "server-only";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelLink, getLink, getOrder, LINK_STATUS, type LinkStatus, paidOnLinkOrders, terminateOrder } from "@/lib/cashfree";
import { telegramSender } from "@/lib/channels/telegram";
import type { MessagingChannel } from "@/lib/channels/types";
import { whatsappSender } from "@/lib/channels/whatsapp";

// Turning a confirmed payment into khata entries. A webhook and a manual check can both
// report the same payment, so everything here is safe to run twice.

const SENDERS = { telegram: telegramSender, whatsapp: whatsappSender };

type PaymentTable = "payment_links" | "payment_qrs";
type PaymentRow = { id: string; merchant_id: string; customer_id: string | null; amount_paid_paise: number | string };

const LABEL: Record<PaymentTable, string> = { payment_links: "payment link", payment_qrs: "in-shop QR" };
const OPEN_STATUSES = ["active", "partially_paid"];

/**
 * Records `paidPaise` as the total paid so far on a link or QR. Returns the newly paid amount
 * in paise, or 0 if this payment was already recorded.
 */
export async function settlePayment(db: SupabaseClient, table: PaymentTable, row: PaymentRow, paidPaise: number, status: LinkStatus) {
  const previouslyPaid = Number(row.amount_paid_paise);
  const newlyPaid = paidPaise - previouslyPaid;

  // Conditional update: if the same payment is reported twice at once, only one report wins
  // this row and records the payment, so the ledger is never double-counted.
  const { data: updated } = await db
    .from(table)
    .update({ status, amount_paid_paise: Math.max(paidPaise, previouslyPaid), updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("amount_paid_paise", previouslyPaid)
    .select("id");

  if (!updated?.length || newlyPaid <= 0 || !row.customer_id) return 0;

  await db.from("ledger_entries").insert({
    merchant_id: row.merchant_id,
    customer_id: row.customer_id,
    kind: "payment_received",
    amount_paise: newlyPaid,
    note: `UPI via Cashfree ${LABEL[table]}`,
    source: "webhook",
  });
  await db.from("audit_log").insert({
    merchant_id: row.merchant_id,
    actor: "cashfree",
    action: table === "payment_links" ? "payment_link_paid" : "payment_qr_paid",
    details: { id: row.id, newlyPaid, status },
  });
  await cancelOpenRequests(db, row.merchant_id, row.customer_id, row.id);
  return newlyPaid;
}

/**
 * Closes a customer's open links and QRs, because their amounts no longer match the balance:
 * without this, paying an old request as well would overpay and push the khata negative.
 * If Cashfree refuses (say the link was paid a moment ago) the row stays open, so the
 * webhook or a payment check can still record that payment.
 */
export async function cancelOpenRequests(db: SupabaseClient, merchantId: string, customerId: string, exceptId?: string) {
  const open = (table: PaymentTable, columns: string) =>
    db.from(table).select(columns).eq("merchant_id", merchantId).eq("customer_id", customerId).in("status", OPEN_STATUSES);
  const [{ data: links }, { data: qrs }] = await Promise.all([
    open("payment_links", "id, cashfree_link_id, expires_at"),
    open("payment_qrs", "id, cashfree_order_id, expires_at"),
  ]);

  const close = async (table: PaymentTable, row: { id: string; expires_at: string | null }, cancel: () => Promise<unknown>) => {
    if (row.id === exceptId) return;
    const setStatus = (status: LinkStatus) =>
      // Only from an open status, so a payment recorded in the meantime is never overwritten.
      db.from(table).update({ status, updated_at: new Date().toISOString() }).eq("id", row.id).in("status", OPEN_STATUSES);

    // Cashfree refuses to cancel what has already expired, so close those here.
    if (row.expires_at && new Date(row.expires_at) < new Date()) return void (await setStatus("expired"));
    try {
      await cancel();
      await setStatus("cancelled");
    } catch (error) {
      console.warn(`[munshi] couldn't cancel ${LABEL[table]} ${row.id}:`, error instanceof Error ? error.message : error);
    }
  };

  for (const row of (links ?? []) as unknown as { id: string; cashfree_link_id: string; expires_at: string | null }[]) {
    await close("payment_links", row, () => cancelLink(row.cashfree_link_id));
  }
  for (const row of (qrs ?? []) as unknown as { id: string; cashfree_order_id: string; expires_at: string | null }[]) {
    await close("payment_qrs", row, () => terminateOrder(row.cashfree_order_id));
  }
}

/** Tells the owner on their linked chat apps that money arrived. A failed notice never fails the payment. */
export async function notifyOwnerOfPayment(db: SupabaseClient, merchantId: string, customerId: string, paidPaise: number) {
  const [{ data: links }, { data: balance }] = await Promise.all([
    db.from("channel_links").select("channel, external_user_id").eq("merchant_id", merchantId),
    db.from("customer_balances").select("name, outstanding_paise").eq("merchant_id", merchantId).eq("customer_id", customerId).maybeSingle(),
  ]);
  const owes = Number(balance?.outstanding_paise ?? 0);
  const text = `💰 ${balance?.name ?? "Customer"} paid ${formatINR(paidPaise)}. ${owes > 0 ? `Still owes ${formatINR(owes)}.` : "Khata clear."}`;

  for (const link of links ?? []) {
    await SENDERS[link.channel as MessagingChannel].sendText(link.external_user_id, text).catch((error: unknown) => {
      console.error("[munshi] payment notice failed:", error);
    });
  }
}

/**
 * Asks Cashfree about a customer's open links and QRs and records anything paid. This is what
 * "Ramesh ka payment aaya?" runs, so it works without a webhook reaching the server.
 */
export async function reconcilePayments(db: SupabaseClient, merchantId: string, customerId?: string) {
  const open = (table: PaymentTable, columns: string) => {
    let q = db.from(table).select(columns).eq("merchant_id", merchantId).in("status", OPEN_STATUSES);
    if (customerId) q = q.eq("customer_id", customerId);
    return q;
  };
  const [{ data: links }, { data: qrs }] = await Promise.all([
    open("payment_links", "id, merchant_id, customer_id, amount_paid_paise, amount_paise, cashfree_link_id"),
    open("payment_qrs", "id, merchant_id, customer_id, amount_paid_paise, amount_paise, cashfree_order_id"),
  ]);

  let paidPaise = 0;
  let stillOpen = 0;

  for (const row of (links ?? []) as unknown as (PaymentRow & { amount_paise: number | string; cashfree_link_id: string })[]) {
    const link = await getLink(row.cashfree_link_id);
    let status: LinkStatus = LINK_STATUS[link.link_status] ?? "active";
    let paid = Math.round(Number(link.link_amount_paid ?? 0) * 100);
    if (status !== "paid") {
      // A link can report EXPIRED after a successful payment, so its orders have the last word.
      paid = Math.max(paid, await paidOnLinkOrders(row.cashfree_link_id));
      if (paid > 0) status = paid >= Number(row.amount_paise) ? "paid" : "partially_paid";
    }
    paidPaise += await settlePayment(db, "payment_links", row, paid, status);
    if (status === "active" || status === "partially_paid") stillOpen++;
  }

  for (const row of (qrs ?? []) as unknown as (PaymentRow & { amount_paise: number | string; cashfree_order_id: string })[]) {
    const order = await getOrder(row.cashfree_order_id);
    if (order.order_status === "PAID") paidPaise += await settlePayment(db, "payment_qrs", row, Number(row.amount_paise), "paid");
    else if (order.order_status === "ACTIVE") stillOpen++;
    else {
      const status = order.order_status === "EXPIRED" ? "expired" : "cancelled";
      await db.from("payment_qrs").update({ status, updated_at: new Date().toISOString() }).eq("id", row.id).in("status", OPEN_STATUSES);
    }
  }

  return { paidPaise, stillOpen };
}
