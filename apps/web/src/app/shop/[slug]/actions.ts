"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { afterSaleRecorded, openStore, orderForBuyer, type PlaceResult, placeOnlineOrder } from "@/lib/online-shop";
import { checkBuyer } from "@/lib/shop";
import { createAdminClient } from "@/lib/supabase/admin";

// The store's server actions. Customers aren't signed in, so these take nothing on trust: the shop
// must be open, the cart is checked against its own products and stock, and prices come from the
// shop. Writes go through the server's client, scoped to that one shop.

const Order = z.object({
  slug: z.string().max(60),
  cart: z.array(z.object({ productId: z.string().max(40), quantity: z.number().positive().max(10_000) })).min(1).max(60),
  buyer: z.object({ name: z.string().max(120), phone: z.string().max(20), address: z.string().max(400).optional() }),
  method: z.enum(["upi", "cod"]),
});

const CLOSED = "This shop isn't taking online orders right now.";

/** The site's own address, for Cashfree to send the customer back to after paying. */
async function appUrl() {
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  return host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : undefined;
}

export async function placeOrder(input: z.input<typeof Order>): Promise<PlaceResult> {
  const parsed = Order.safeParse(input);
  if (!parsed.success) return { error: "Something in the order doesn't look right. Refresh the page and try again." };
  const { slug, cart, method } = parsed.data;
  const buyer = checkBuyer(parsed.data.buyer);
  if ("error" in buyer) return buyer;

  const admin = createAdminClient();
  const store = await openStore(admin, slug);
  if (!store) return { error: CLOSED };
  const result = await placeOnlineOrder(admin, store, { cart, buyer, method, appUrl: await appUrl() });
  // Cash on delivery is recorded now: tell the owner, and ask about anything now low.
  if ("status" in result && result.status === "paid") after(() => afterSaleRecorded(admin, store.merchantId, result.orderId));
  return result;
}

/** The order page asks every few seconds while a UPI payment is pending. */
export async function orderStatus(slug: string, orderId: string): Promise<{ status: "open" | "paid" | "cancelled" } | { error: string }> {
  const admin = createAdminClient();
  const store = await openStore(admin, String(slug), { evenClosed: true });
  if (!store) return { error: "No such order." };
  const found = await orderForBuyer(admin, store, String(orderId));
  if (!found) return { error: "No such order." };
  if (found.recorded) after(() => afterSaleRecorded(admin, store.merchantId, found.order.id));
  return { status: found.order.status };
}
