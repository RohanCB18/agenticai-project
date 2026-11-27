import "server-only";
import { defaultAlertLevel } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { type BillItem, rupees } from "@/lib/counter-bill";
import { cancelLink, createPaymentLink, getLink, LINK_STATUS, type LinkStatus, paidOnLinkOrders } from "@/lib/cashfree";

// Counter billing on the server. A bill paid in cash or as udhaar is recorded the moment it is
// made; a UPI bill gets a Cashfree payment page, shown at the counter as a QR the customer scans,
// and is recorded when Cashfree says it was paid (its webhook, or the till asking every few
// seconds, whichever is first). settle_counter_sale records a bill once: the sale (or udhaar),
// and every item out of stock.

export type CounterMethod = "upi" | "cash" | "udhaar";
export type SaleStatus = "open" | "paid" | "cancelled";

/** A UPI page at the counter is for paying now. */
const COUNTER_LINK_TTL_MS = 60 * 60_000;

/** Munshi's id for a counter bill's payment page: 40 characters, under Cashfree's 50. */
export const newCounterLinkId = () => `counter_${crypto.randomUUID().replaceAll("-", "")}`;

export async function saveSale(
  admin: SupabaseClient,
  sale: { merchantId: string; method: CounterMethod; customerId: string | null; items: BillItem[]; totalPaise: number },
): Promise<string> {
  const { data, error } = await admin
    .from("counter_sales")
    .insert({ merchant_id: sale.merchantId, method: sale.method, customer_id: sale.customerId, items: sale.items, total_paise: sale.totalPaise })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Save bill failed: ${error?.message}`);
  return data.id as string;
}

/** Records a bill as paid, once. True when this call recorded it. */
export async function settleSale(admin: SupabaseClient, saleId: string, merchantId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("settle_counter_sale", { p_sale_id: saleId, p_merchant_id: merchantId });
  if (error) throw new Error(`Record bill failed: ${error.message}`);
  return data === true;
}

/** The Cashfree page for a UPI bill, and its QR for the counter screen. */
export async function openPaymentPage(
  admin: SupabaseClient,
  sale: { id: string; merchantId: string; shopName: string; phone: string | null; items: BillItem[]; totalPaise: number },
  /** An online order: the customer's own name and number, and where Cashfree sends them back after paying. */
  online?: { buyer: { name: string; phone: string }; returnUrl?: string },
): Promise<{ url: string; qr: string }> {
  const linkId = newCounterLinkId();
  // Saved first, so a webhook that races the answer finds the bill.
  await admin.from("counter_sales").update({ cashfree_link_id: linkId }).eq("id", sale.id);
  const what = sale.items.map((i) => i.name).join(", ");
  const appUrl = process.env.PUBLIC_APP_URL;
  const link = await createPaymentLink({
    linkId,
    amountPaise: sale.totalPaise,
    purpose: `${online ? "Order from" : "Bill at"} ${sale.shopName}: ${what}`.slice(0, 200),
    // A walk-in's page carries the shop's name and number (Cashfree needs one); an online order, the customer's.
    customer: online?.buyer ?? { name: sale.shopName, phone: sale.phone || "9999999999" },
    expiresAt: new Date(Date.now() + COUNTER_LINK_TTL_MS),
    notifyUrl: appUrl?.startsWith("https://") ? `${appUrl}/api/webhooks/cashfree` : undefined,
    returnUrl: online?.returnUrl?.startsWith("https://") ? online.returnUrl : undefined,
    notes: { merchant_id: sale.merchantId, purpose: online ? "online_order" : "counter_sale", sale_id: sale.id },
    sendSms: false,
  });
  await admin.from("counter_sales").update({ payment_url: link.link_url }).eq("id", sale.id);
  const qr = await QRCode.toDataURL(link.link_url, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  return { url: link.link_url, qr };
}

/** Paid in full by Cashfree's account of it: a link's own status can stay EXPIRED after a payment, so its orders count too. */
export const linkPaid = (status: LinkStatus, paidPaise: number, totalPaise: number) => status === "paid" || paidPaise >= totalPaise;

type SaleRow = { id: string; merchant_id: string; status: SaleStatus; total_paise: number | string; cashfree_link_id: string | null };

/**
 * Where a bill stands. A UPI bill still open is checked with Cashfree and recorded if it was paid.
 * `recorded` is true when this call recorded it (so the caller asks about restocking).
 */
export async function checkSale(admin: SupabaseClient, merchantId: string, saleId: string): Promise<{ status: SaleStatus; recorded: boolean }> {
  const { data } = await admin.from("counter_sales").select("id, merchant_id, status, total_paise, cashfree_link_id").eq("id", saleId).eq("merchant_id", merchantId).maybeSingle();
  const sale = data as SaleRow | null;
  if (!sale) throw new Error("No such bill");
  if (sale.status !== "open" || !sale.cashfree_link_id) return { status: sale.status, recorded: false };
  const [link, paid] = await Promise.all([getLink(sale.cashfree_link_id), paidOnLinkOrders(sale.cashfree_link_id)]);
  if (!linkPaid(LINK_STATUS[link.link_status] ?? "active", paid, Number(sale.total_paise))) return { status: "open", recorded: false };
  const recorded = await settleSale(admin, sale.id, merchantId);
  console.info(`[munshi] counter bill ${sale.id} paid (checked with Cashfree)${recorded ? "" : ", already recorded"}`);
  return { status: "paid", recorded };
}

/**
 * The Cashfree webhook for a link that may be a counter bill's. False if it isn't one; otherwise
 * the shop, and whether this report recorded the payment.
 */
export async function settleCounterLink(
  admin: SupabaseClient,
  linkId: string,
  status: LinkStatus,
  paidPaise: number,
): Promise<false | { merchantId: string; saleId: string; recorded: boolean }> {
  const { data } = await admin.from("counter_sales").select("id, merchant_id, status, total_paise, cashfree_link_id").eq("cashfree_link_id", linkId).maybeSingle();
  const sale = data as SaleRow | null;
  if (!sale) return false;
  const found = { merchantId: sale.merchant_id, saleId: sale.id };
  if (sale.status !== "open" || !linkPaid(status, paidPaise, Number(sale.total_paise))) return { ...found, recorded: false };
  return { ...found, recorded: await settleSale(admin, sale.id, sale.merchant_id) };
}

/** Takes an unpaid UPI bill off the counter, and closes its page so nobody pays it later. */
export async function cancelSale(admin: SupabaseClient, merchantId: string, saleId: string) {
  const { data } = await admin
    .from("counter_sales")
    .update({ status: "cancelled" })
    .eq("id", saleId)
    .eq("merchant_id", merchantId)
    .eq("status", "open")
    .select("cashfree_link_id")
    .maybeSingle();
  const linkId = (data as { cashfree_link_id: string | null } | null)?.cashfree_link_id;
  if (linkId) await cancelLink(linkId).catch((error: unknown) => console.warn(`[munshi] counter page ${linkId} not cancelled:`, error instanceof Error ? error.message : error));
  return Boolean(data);
}

/** The bill's products now at or below their alert level, as "Rice (59 kg left)". */
export async function lowAfterSale(admin: SupabaseClient, merchantId: string, productIds: string[]): Promise<string[]> {
  if (productIds.length === 0) return [];
  const { data } = await admin.from("products").select("name, unit, stock_qty, reorder_level").eq("merchant_id", merchantId).in("id", productIds);
  return ((data ?? []) as { name: string; unit: string; stock_qty: number | string; reorder_level: number | string | null }[])
    .filter((p) => Number(p.stock_qty) <= Number(p.reorder_level ?? defaultAlertLevel(p.unit)))
    .map((p) => `${p.name} (${Number(Number(p.stock_qty).toFixed(3))} ${p.unit} left)`);
}

/** One line for the owner's records: "Counter bill ₹190: Rice 1.5 kg, Parle G 2 box". */
export const billSummary = (items: BillItem[], totalPaise: number) => `Counter bill ${rupees(totalPaise)}: ${items.map((i) => `${i.name} ${i.quantity} ${i.unit}`).join(", ")}`;
