import type { Product, SupplierAgent, SupplierDelivery } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDelivery } from "./deliveries";
import { notifyOwner } from "./payments";

vi.mock("./payments", () => ({ notifyOwner: vi.fn(async () => {}) }));
vi.mock("./khata-store", () => ({
  createSupabaseKhataStore: () => ({
    listProducts: async (): Promise<Product[]> => [
      { id: "maggi", name: "Maggi Noodles", aliases: [], unit: "packet", stockQty: 9, reorderLevel: 10, pricePaise: null },
      { id: "moong", name: "Moong Dal", aliases: [], unit: "kg", stockQty: 12, reorderLevel: 10, pricePaise: null },
    ],
  }),
}));

type Order = { id: string; merchant_id: string; supplier: string; order_ref: string; quote_id: string; status: string; created_at: string };

/** supplier_orders, audit_log and receive_supplier_order: enough for a delivery. */
function fakeDb(orders: Order[]) {
  const received: { orderId: string; items: unknown; invoice: string }[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => (filters.push([key, value]), q),
      insert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: table === "supplier_orders" ? (orders.find((o) => filters.every(([k, v]) => o[k as keyof Order] === v)) ?? null) : null, error: null }),
    };
    return q;
  };
  const rpc = async (_name: string, args: { p_order_id: string; p_items: unknown; p_invoice: string }) => {
    const order = orders.find((o) => o.id === args.p_order_id && o.status === "confirmed");
    if (!order) return { data: false, error: null };
    order.status = "delivered";
    received.push({ orderId: order.order_ref, items: args.p_items, invoice: args.p_invoice });
    return { data: true, error: null };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, received };
}

function wholesaler(note: SupplierDelivery) {
  const asked: unknown[] = [];
  const agent: SupplierAgent = {
    name: "Sharma Traders",
    quote: async () => {
      throw new Error("not quoted here");
    },
    order: async () => {
      throw new Error("not ordered here");
    },
    delivery: async (order) => (asked.push(order), note),
  };
  return { agent, asked };
}

const delivered: SupplierDelivery = {
  status: "delivered",
  supplier: "Sharma Traders",
  orderId: "ST-1A2B3C4D",
  invoiceNo: "INV-1A2B3C4D",
  lines: [
    { requested: "Maggi Noodles", item: "Maggi Noodles", quantity: 48, unit: "packet", amount: "₹576" },
    { requested: "Moong Dal", item: "Moong Dal", quantity: 10, unit: "kg", amount: "₹1,160" },
  ],
  total: "₹1,736",
  totalPaise: 173600,
  deliveredAt: "2026-11-28T05:30:00Z",
};

let orders: Order[];

beforeEach(() => {
  vi.clearAllMocks();
  orders = [{ id: "o1", merchant_id: "m1", supplier: "Sharma Traders", order_ref: "ST-1A2B3C4D", quote_id: "q.u.ote", status: "confirmed", created_at: "2026-11-28T04:00:00Z" }];
});

describe("a wholesaler's delivery", () => {
  it("waits while the order is on its way", async () => {
    const { db, received } = fakeDb(orders);
    const { agent, asked } = wholesaler({ status: "on_the_way", supplier: "Sharma Traders", orderId: "ST-1A2B3C4D", expectedAt: "2026-11-28T05:30:00Z", deliverySlot: "today" });
    expect(await checkDelivery(db, "m1", "ST-1A2B3C4D", agent)).toEqual({ status: "on_the_way", expectedAt: "2026-11-28T05:30:00Z" });
    // The wholesaler is asked about this order, from the quote it was placed with, and when.
    expect(asked).toEqual([{ orderId: "ST-1A2B3C4D", quoteId: "q.u.ote", orderedAt: "2026-11-28T04:00:00Z" }]);
    expect(received).toEqual([]);
    expect(notifyOwner).not.toHaveBeenCalled();
  });

  it("goes into stock once delivered, and the owner hears what came", async () => {
    const { db, received } = fakeDb(orders);
    const { agent } = wholesaler(delivered);
    expect(await checkDelivery(db, "m1", "ST-1A2B3C4D", agent)).toEqual({ status: "delivered" });
    expect(received).toEqual([
      {
        orderId: "ST-1A2B3C4D",
        invoice: "INV-1A2B3C4D",
        items: [
          { productId: "maggi", name: "Maggi Noodles", quantity: 48, unit: "packet" },
          { productId: "moong", name: "Moong Dal", quantity: 10, unit: "kg" },
        ],
      },
    ]);
    expect(vi.mocked(notifyOwner).mock.calls[0]![2]).toContain("• Maggi Noodles +48 packet: 9 → 57");

    // Reported again (a retried check): nothing more is added, and nothing more is said.
    expect(await checkDelivery(db, "m1", "ST-1A2B3C4D", agent)).toEqual({ status: "done" });
    expect(received).toHaveLength(1);
    expect(notifyOwner).toHaveBeenCalledTimes(1);
  });

  it("stops for an order that isn't this shop's, or a wholesaler that doesn't track deliveries", async () => {
    const { db } = fakeDb(orders);
    expect(await checkDelivery(db, "m2", "ST-1A2B3C4D", wholesaler(delivered).agent)).toEqual({ status: "done" });
    const untracked: SupplierAgent = { ...wholesaler(delivered).agent, name: "Sharma Traders", delivery: undefined };
    expect(await checkDelivery(db, "m1", "ST-1A2B3C4D", untracked)).toEqual({ status: "unknown" });
  });
});
