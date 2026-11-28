import "server-only";
import { deliveryMessage, placeDelivery, type SupplierAgent } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseKhataStore } from "@/lib/khata-store";
import { notifyOwner } from "@/lib/payments";
import { configuredSupplier } from "@/lib/supplier";

// Wholesaler deliveries, received by Munshi itself. Every order placed with the wholesaler is
// watched by a durable workflow (workflows/supplier-delivery.ts) that asks the wholesaler's agent
// where it is, sleeps until it's due, and asks again; once delivered, the delivery note's lines
// go into stock (receive_supplier_order, once) and the owner is told what came. Nobody sends a
// photo of the bill: the wholesaler's own system sends it, as data.

export type DeliveryCheck =
  | { status: "on_the_way"; expectedAt: string | null }
  | { status: "delivered" } // recorded now
  | { status: "done" } // delivered or cancelled before
  | { status: "unknown" }; // no wholesaler that tracks deliveries

type OrderRow = { id: string; supplier: string; order_ref: string; quote_id: string; status: string; created_at: string };

/** Asks the wholesaler about one order and, once it's delivered, adds its goods to stock and tells the owner. */
export async function checkDelivery(admin: SupabaseClient, merchantId: string, orderRef: string, supplier: SupplierAgent | undefined = configuredSupplier()): Promise<DeliveryCheck> {
  const { data } = await admin.from("supplier_orders").select("id, supplier, order_ref, quote_id, status, created_at").eq("merchant_id", merchantId).eq("order_ref", orderRef).maybeSingle();
  const order = data as OrderRow | null;
  if (!order || order.status !== "confirmed") return { status: "done" };
  if (!supplier?.delivery) return { status: "unknown" };

  const note = await supplier.delivery({ orderId: order.order_ref, quoteId: order.quote_id, orderedAt: order.created_at });
  if (note.status !== "delivered") return { status: "on_the_way", expectedAt: note.expectedAt ?? null };

  const products = await createSupabaseKhataStore(admin, merchantId, { source: "telegram", actor: "deliveries" }).listProducts();
  const { received, unplaced } = placeDelivery(note.lines, products);
  const items = received.map((r) => ({ productId: r.product.id, name: r.product.name, quantity: r.quantity, unit: r.product.unit }));
  const { data: recorded, error } = await admin.rpc("receive_supplier_order", {
    p_order_id: order.id,
    p_merchant_id: merchantId,
    p_items: items,
    p_invoice: note.invoiceNo,
    p_delivered_at: note.deliveredAt,
  });
  if (error) throw new Error(`Record delivery failed: ${error.message}`);
  if (recorded !== true) return { status: "done" };

  console.info(`[munshi] delivery ${order.order_ref} received: ${items.length} lines into stock, ${unplaced.length} left for the owner`);
  await admin.from("audit_log").insert({
    merchant_id: merchantId,
    actor: "deliveries",
    action: "supplier_delivery",
    details: { orderId: order.order_ref, invoiceNo: note.invoiceNo, received: items, unplaced: unplaced.map((u) => ({ item: u.line.item, quantity: u.line.quantity, unit: u.line.unit, why: u.why })) },
  });
  await notifyOwner(admin, merchantId, deliveryMessage(note, received, unplaced));
  return { status: "delivered" };
}

/** Starts watching a new order until it's delivered. Never throws: the order stands either way. */
export async function watchDelivery(merchantId: string, orderRef: string) {
  try {
    const [{ start }, { supplierDelivery }] = await Promise.all([import("workflow/api"), import("@/workflows/supplier-delivery")]);
    await start(supplierDelivery, [{ merchantId, orderRef }]);
  } catch (error) {
    console.error(`[munshi] couldn't start watching delivery ${orderRef}:`, error instanceof Error ? error.message : error);
  }
}
