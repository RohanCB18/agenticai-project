"use server";

import { after } from "next/server";
import { getCurrentMerchant } from "@/lib/auth";
import { buildBill, cleanBarcode, type TillLine } from "@/lib/counter-bill";
import { billSummary, cancelSale, checkSale, type CounterMethod, lowAfterSale, openPaymentPage, saveSale, settleSale } from "@/lib/counter";
import { alertLowStock } from "@/lib/restock";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The counter's server actions. The owner is signed in, so reads go through their own client (RLS
// scopes them to the shop); bills are written by the server, which works out every total itself.

/** low: what the bill took to its alert level; asking: whether a linked chat gets the restock ask. */
export type CheckoutResult =
  | { status: "paid"; saleId: string; totalPaise: number; low: string[]; asking: boolean }
  | { status: "open"; saleId: string; totalPaise: number; url: string; qr: string }
  | { error: string };

/** After a bill is recorded: ask about restocking anything it took to its alert level, on the owner's chat app. */
function askAboutRestock(merchantId: string) {
  after(() => alertLowStock(createAdminClient(), merchantId));
}

/** Whether the shop has a chat app linked, where restock asks go. */
async function chatLinked(admin: ReturnType<typeof createAdminClient>, merchantId: string) {
  const { count } = await admin.from("channel_links").select("channel", { count: "exact", head: true }).eq("merchant_id", merchantId);
  return (count ?? 0) > 0;
}

export async function checkout(input: { lines: TillLine[]; method: CounterMethod; customerId?: string | null }): Promise<CheckoutResult> {
  const merchant = await getCurrentMerchant();
  if (!["upi", "cash", "udhaar"].includes(input.method)) return { error: "Choose how the customer pays." };
  const db = await createClient();
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const { data: products } = await db.from("products").select("id, name, unit, price_paise").in("id", ids);
  const bill = buildBill(input.lines, products ?? []);
  if ("error" in bill) return bill;

  let customerId: string | null = null;
  if (input.method === "udhaar") {
    const { data: customer } = await db.from("customers").select("id").eq("id", input.customerId ?? "").maybeSingle();
    if (!customer) return { error: "Choose whose udhaar this is." };
    customerId = customer.id as string;
  }

  // A price typed at the counter becomes the product's price, so the next bill fills it in.
  for (const item of bill.items) {
    const product = products?.find((p) => p.id === item.productId);
    if (product && product.price_paise !== item.pricePaise) await db.from("products").update({ price_paise: item.pricePaise }).eq("id", item.productId);
  }

  const admin = createAdminClient();
  let saleId: string;
  try {
    saleId = await saveSale(admin, { merchantId: merchant.id, method: input.method, customerId, items: bill.items, totalPaise: bill.totalPaise });
  } catch (error) {
    console.error("[munshi] counter bill not saved:", error instanceof Error ? error.message : error);
    return { error: "Couldn't save the bill. Nothing was recorded; try again." };
  }
  await admin.from("audit_log").insert({ merchant_id: merchant.id, actor: "owner", action: "counter_bill", details: { saleId, method: input.method, summary: billSummary(bill.items, bill.totalPaise) } });

  if (input.method === "upi") {
    const { data: shop } = await admin.from("merchants").select("phone").eq("id", merchant.id).single();
    try {
      const page = await openPaymentPage(admin, { id: saleId, merchantId: merchant.id, shopName: merchant.shopName, phone: (shop?.phone as string | null) ?? null, items: bill.items, totalPaise: bill.totalPaise });
      return { status: "open", saleId, totalPaise: bill.totalPaise, ...page };
    } catch (error) {
      console.error("[munshi] counter payment page failed:", error instanceof Error ? error.message : error);
      await cancelSale(admin, merchant.id, saleId);
      return { error: "Cashfree didn't make the payment page. Nothing was recorded: take cash, or try UPI again." };
    }
  }

  // Cash or udhaar: paid now.
  await settleSale(admin, saleId, merchant.id);
  askAboutRestock(merchant.id);
  const [low, asking] = await Promise.all([lowAfterSale(admin, merchant.id, ids), chatLinked(admin, merchant.id)]);
  return { status: "paid", saleId, totalPaise: bill.totalPaise, low, asking };
}

/** The till asks every few seconds while a UPI bill is on screen. */
export async function saleStatus(saleId: string): Promise<{ status: "open" | "paid" | "cancelled"; low: string[]; asking: boolean } | { error: string }> {
  const merchant = await getCurrentMerchant();
  const admin = createAdminClient();
  try {
    const { status, recorded } = await checkSale(admin, merchant.id, saleId);
    if (recorded) askAboutRestock(merchant.id);
    if (status !== "paid") return { status, low: [], asking: false };
    const { data } = await admin.from("counter_sales").select("items").eq("id", saleId).single();
    const ids = ((data?.items ?? []) as { productId: string }[]).map((i) => i.productId);
    const [low, asking] = await Promise.all([lowAfterSale(admin, merchant.id, ids), chatLinked(admin, merchant.id)]);
    return { status, low, asking };
  } catch (error) {
    console.warn("[munshi] counter bill check failed:", error instanceof Error ? error.message : error);
    return { error: "Couldn't check with Cashfree just now." };
  }
}

export async function cancelBill(saleId: string) {
  const merchant = await getCurrentMerchant();
  return { cancelled: await cancelSale(createAdminClient(), merchant.id, saleId) };
}

/** Links a scanned code to a product, the first time the owner scans it. */
export async function linkBarcode(productId: string, rawCode: string): Promise<{ ok: true; barcode: string } | { error: string }> {
  await getCurrentMerchant();
  const barcode = cleanBarcode(rawCode);
  if (!barcode) return { error: "That doesn't look like a barcode." };
  const db = await createClient();
  const { data: taken } = await db.from("products").select("id, name").eq("barcode", barcode).neq("id", productId).maybeSingle();
  if (taken) return { error: `This barcode is already on ${taken.name}.` };
  const { error } = await db.from("products").update({ barcode }).eq("id", productId);
  if (error) return { error: `Couldn't save the barcode: ${error.message}` };
  return { ok: true, barcode };
}
