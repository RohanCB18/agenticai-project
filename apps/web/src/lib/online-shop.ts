import "server-only";
import { defaultAlertLevel } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type BillItem, buildBill, rupees } from "@/lib/counter-bill";
import { checkSale, openPaymentPage, type SaleStatus, settleSale } from "@/lib/counter";
import { alertLowStock, linkedChats } from "@/lib/restock";
import { aisleOf, alreadySells, type Buyer, canOrder, type CartLine, cartToLines, maskPhone, MAX_ORDER_PAISE, SAMPLE_PRODUCTS, shopSlug } from "@/lib/shop";

// The shop's online store on the server. Anyone can open an open shop's page and order, so every
// read and write here goes through the server with the shop's id, and every price, name, total
// and stock check comes from the shop's own products. An order is a counter_sales row with channel
// 'online': cash on delivery is recorded when placed, UPI when Cashfree says it was paid, and
// either way settle_counter_sale takes the goods out of stock once.

export type StoreProduct = {
  id: string;
  name: string;
  unit: string;
  pricePaise: number;
  /** The most one order can take: what's on the shelf, in whole steps. */
  most: number;
  aisle: string;
  emoji: string;
};

export type Store = { merchantId: string; shopName: string; slug: string; phone: string | null };

/**
 * An open shop by its address, or null (no such shop, or the owner hasn't opened it). `evenClosed`:
 * for an order already placed, whose customer can still see it after the owner closes the store.
 */
export async function openStore(admin: SupabaseClient, slug: string, { evenClosed = false } = {}): Promise<Store | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  let query = admin.from("merchants").select("id, shop_name, shop_slug, phone").eq("shop_slug", slug);
  if (!evenClosed) query = query.eq("shop_open", true);
  const { data } = await query.maybeSingle();
  if (!data) return null;
  return { merchantId: data.id as string, shopName: data.shop_name as string, slug: data.shop_slug as string, phone: (data.phone as string | null) ?? null };
}

type ProductRow = { id: string; name: string; aliases: string[] | null; unit: string; stock_qty: number | string; price_paise: number | string | null };

/** What the store sells: every product with a price, sold out or not. */
export async function storeProducts(admin: SupabaseClient, merchantId: string): Promise<StoreProduct[]> {
  const { data } = await admin.from("products").select("id, name, aliases, unit, stock_qty, price_paise").eq("merchant_id", merchantId).gt("price_paise", 0).order("name");
  return ((data ?? []) as ProductRow[]).map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    pricePaise: Number(p.price_paise),
    most: canOrder(Number(p.stock_qty), p.unit),
    ...aisleOf(p.name, p.aliases ?? []),
  }));
}

/** Online orders a shop takes in 10 minutes, and from one number: enough for a demo room, not for a script. */
const RATE_WINDOW_MS = 10 * 60_000;
const MAX_ORDERS_PER_SHOP = 60;
const MAX_ORDERS_PER_PHONE = 6;
/** UPI now, on Cashfree's page, or cash on delivery. */
export type OnlineMethod = "upi" | "cod";

export type PlaceResult = { orderId: string; status: "paid" } | { orderId: string; status: "open"; payUrl: string } | { error: string };

export async function placeOnlineOrder(
  admin: SupabaseClient,
  store: Store,
  order: { cart: CartLine[]; buyer: Buyer; method: OnlineMethod; appUrl?: string },
): Promise<PlaceResult> {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const recent = (phone?: string) => {
    let q = admin.from("counter_sales").select("id", { count: "exact", head: true }).eq("merchant_id", store.merchantId).eq("channel", "online").gte("created_at", since);
    if (phone) q = q.eq("buyer_phone", phone);
    return q;
  };
  const [{ count: shopCount }, { count: phoneCount }] = await Promise.all([recent(), recent(order.buyer.phone)]);
  if ((shopCount ?? 0) >= MAX_ORDERS_PER_SHOP || (phoneCount ?? 0) >= MAX_ORDERS_PER_PHONE) return { error: "The shop is taking a lot of orders just now. Try again in a few minutes." };

  const ids = [...new Set(order.cart.map((l) => l.productId))].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const { data } = await admin.from("products").select("id, name, aliases, unit, stock_qty, price_paise").eq("merchant_id", store.merchantId).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const products = ((data ?? []) as ProductRow[]).map((p) => ({ id: p.id, name: p.name, unit: p.unit, stock: Number(p.stock_qty), pricePaise: p.price_paise === null ? null : Number(p.price_paise) }));
  const lines = cartToLines(order.cart, products);
  if ("error" in lines) return lines;
  const bill = buildBill(lines, products);
  if ("error" in bill) return bill;
  if (bill.totalPaise > MAX_ORDER_PAISE) return { error: `An online order can be up to ${rupees(MAX_ORDER_PAISE)}. Split it, or call the shop.` };

  const method = order.method === "upi" ? "upi" : "cash";
  const { data: sale, error } = await admin
    .from("counter_sales")
    .insert({
      merchant_id: store.merchantId,
      channel: "online",
      method,
      items: bill.items,
      total_paise: bill.totalPaise,
      buyer_name: order.buyer.name,
      buyer_phone: order.buyer.phone,
      buyer_address: order.buyer.address,
    })
    .select("id")
    .single();
  if (error || !sale) {
    console.error("[munshi] online order not saved:", error?.message);
    return { error: "Couldn't place the order. Nothing was charged; try again." };
  }
  const orderId = sale.id as string;
  await admin.from("audit_log").insert({ merchant_id: store.merchantId, actor: "customer", action: "online_order", details: { orderId, method, totalPaise: bill.totalPaise, items: bill.items.length } });

  if (method === "cash") {
    await settleSale(admin, orderId, store.merchantId);
    return { orderId, status: "paid" };
  }
  try {
    const page = await openPaymentPage(
      admin,
      { id: orderId, merchantId: store.merchantId, shopName: store.shopName, phone: store.phone, items: bill.items, totalPaise: bill.totalPaise },
      { buyer: { name: order.buyer.name, phone: order.buyer.phone }, returnUrl: order.appUrl ? `${order.appUrl}/shop/${store.slug}/order/${orderId}` : undefined },
    );
    return { orderId, status: "open", payUrl: page.url };
  } catch (error) {
    console.error("[munshi] online order payment page failed:", error instanceof Error ? error.message : error);
    await admin.from("counter_sales").update({ status: "cancelled" }).eq("id", orderId).eq("status", "open");
    return { error: "Cashfree couldn't open the payment page. Nothing was charged: try again, or choose cash on delivery." };
  }
}

export type OrderView = {
  id: string;
  status: SaleStatus;
  method: "upi" | "cash";
  items: BillItem[];
  totalPaise: number;
  buyerName: string;
  address: string | null;
  payUrl: string | null;
  placedAt: string;
};

type OrderRow = {
  id: string;
  merchant_id: string;
  status: SaleStatus;
  method: "upi" | "cash";
  items: BillItem[];
  total_paise: number | string;
  buyer_name: string;
  buyer_address: string | null;
  payment_url: string | null;
  created_at: string;
};

/**
 * An online order as its customer sees it, by its id (unguessable, and only in their link). A UPI
 * order still open is checked with Cashfree first; `recorded` is true when this call recorded it.
 */
export async function orderForBuyer(admin: SupabaseClient, store: Store, orderId: string): Promise<{ order: OrderView; recorded: boolean } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const read = async () => {
    const { data } = await admin
      .from("counter_sales")
      .select("id, merchant_id, status, method, items, total_paise, buyer_name, buyer_address, payment_url, created_at")
      .eq("id", orderId)
      .eq("merchant_id", store.merchantId)
      .eq("channel", "online")
      .maybeSingle();
    return data as OrderRow | null;
  };
  let row = await read();
  if (!row) return null;
  let recorded = false;
  if (row.status === "open" && row.method === "upi") {
    try {
      recorded = (await checkSale(admin, store.merchantId, orderId)).recorded;
      row = (await read()) ?? row;
    } catch (error) {
      console.warn("[munshi] online order check failed:", error instanceof Error ? error.message : error);
    }
  }
  return {
    recorded,
    order: {
      id: row.id,
      status: row.status,
      method: row.method,
      items: row.items,
      totalPaise: Number(row.total_paise),
      buyerName: row.buyer_name,
      address: row.buyer_address,
      payUrl: row.status === "open" ? row.payment_url : null,
      placedAt: row.created_at,
    },
  };
}

/** The owner's message about a new online order: what to pack, for whom, and whether it's paid. */
export function orderMessage(order: { items: BillItem[]; totalPaise: number; method: "upi" | "cash"; buyerName: string; buyerPhone: string; address: string | null }) {
  const lines = order.items.map((i) => `• ${i.name} × ${Number(i.quantity.toFixed(3))} ${i.unit}`);
  return [
    `🛒 New online order, ${rupees(order.totalPaise)}, from ${order.buyerName} (${maskPhone(order.buyerPhone)})`,
    ...lines,
    order.method === "upi" ? "✅ Paid by UPI" : "💵 Cash on delivery",
    ...(order.address ? [`📍 ${order.address}`] : []),
    "Stock is updated.",
  ].join("\n");
}

/**
 * After a bill or an order is recorded: an online order is announced to the owner, then anything it
 * took to its alert level gets the restock ask. Never throws; meant for after().
 */
export async function afterSaleRecorded(admin: SupabaseClient, merchantId: string, saleId: string) {
  try {
    const { data } = await admin.from("counter_sales").select("channel, method, items, total_paise, buyer_name, buyer_phone, buyer_address").eq("id", saleId).eq("merchant_id", merchantId).maybeSingle();
    if (data?.channel === "online") {
      const chats = await linkedChats(admin, merchantId);
      await chats.tell(
        orderMessage({
          items: data.items as BillItem[],
          totalPaise: Number(data.total_paise),
          method: data.method as "upi" | "cash",
          buyerName: data.buyer_name as string,
          buyerPhone: data.buyer_phone as string,
          address: (data.buyer_address as string | null) ?? null,
        }),
      );
    }
  } catch (error) {
    console.error("[munshi] online order notice failed:", error instanceof Error ? error.message : error);
  }
  await alertLowStock(admin, merchantId);
}

// ---------------------------------------------------------------- the owner's side

/** Opens or closes the store. The first time, it gets its address from the shop's name. */
export async function setStoreOpen(admin: SupabaseClient, merchantId: string, open: boolean): Promise<{ slug: string | null }> {
  const { data: shop } = await admin.from("merchants").select("shop_name, shop_slug").eq("id", merchantId).single();
  let slug = (shop?.shop_slug as string | null) ?? null;
  if (open && !slug) {
    const base = shopSlug((shop?.shop_name as string | undefined) ?? "shop");
    for (let n = 1; n <= 20 && !slug; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const { error } = await admin.from("merchants").update({ shop_slug: candidate }).eq("id", merchantId);
      if (!error) slug = candidate;
      else if (error.code !== "23505") throw new Error(`Couldn't give the store an address: ${error.message}`);
    }
    if (!slug) throw new Error("Couldn't give the store an address.");
  }
  await admin.from("merchants").update({ shop_open: open }).eq("id", merchantId);
  return { slug };
}

/**
 * For a demo: adds a small supermarket's everyday range the shop doesn't already sell, with prices
 * and opening stock (as a stock-in, so the books add up), and fills in prices missing on the shop's
 * own matching products. Returns how many were added and priced.
 */
export async function addSampleProducts(admin: SupabaseClient, merchantId: string): Promise<{ added: number; priced: number }> {
  const { data } = await admin.from("products").select("id, name, aliases, price_paise").eq("merchant_id", merchantId);
  const existing = ((data ?? []) as { id: string; name: string; aliases: string[] | null; price_paise: number | null }[]).map((p) => ({ ...p, aliases: p.aliases ?? [] }));
  let added = 0;
  let priced = 0;
  for (const sample of SAMPLE_PRODUCTS) {
    const mine = existing.find((p) => alreadySells(sample, [p]));
    if (mine) {
      if (mine.price_paise === null) {
        await admin.from("products").update({ price_paise: sample.pricePaise }).eq("id", mine.id).eq("merchant_id", merchantId);
        priced++;
      }
      continue;
    }
    const { data: product, error } = await admin
      .from("products")
      .insert({ merchant_id: merchantId, name: sample.name, aliases: sample.aliases, unit: sample.unit, price_paise: sample.pricePaise, stock_qty: 0 })
      .select("id")
      .single();
    if (error || !product) throw new Error(`Couldn't add ${sample.name}: ${error?.message}`);
    await admin.from("stock_movements").insert({ merchant_id: merchantId, product_id: product.id, delta: sample.stock, reason: "opening stock", source: "system" });
    added++;
  }
  await admin.from("audit_log").insert({ merchant_id: merchantId, actor: "owner", action: "sample_products", details: { added, priced } });
  return { added, priced };
}

/**
 * For running the demo again: brings every product at or below its alert level back up to a few
 * orders above it, as a stock-in (which also lets Munshi ask about it again when it runs low).
 */
export async function refillLowStock(admin: SupabaseClient, merchantId: string): Promise<{ refilled: string[] }> {
  const { data } = await admin.from("products").select("id, name, unit, stock_qty, reorder_level").eq("merchant_id", merchantId);
  const refilled: string[] = [];
  for (const p of (data ?? []) as { id: string; name: string; unit: string; stock_qty: number | string; reorder_level: number | string | null }[]) {
    const level = Number(p.reorder_level ?? defaultAlertLevel(p.unit));
    const stock = Number(p.stock_qty);
    if (stock > level) continue;
    const target = Math.ceil(level * 1.6) + 2;
    await admin.from("stock_movements").insert({ merchant_id: merchantId, product_id: p.id, delta: target - stock, reason: "demo refill", source: "system" });
    refilled.push(p.name);
  }
  if (refilled.length) await admin.from("audit_log").insert({ merchant_id: merchantId, actor: "owner", action: "demo_refill", details: { refilled } });
  return { refilled };
}
