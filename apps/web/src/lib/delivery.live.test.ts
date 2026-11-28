import { placeDelivery, type Product } from "@munshi/agents";
import { describe, expect, it } from "vitest";
import { createA2ASupplier } from "./supplier";

// A whole delivery over A2A against a real wholesaler agent: quote, order, "on its way", then the
// delivery note once the van is due, placed on the shop's products. DELIVERY_LIVE=1 with
// WHOLESALER_URL pointing at a wholesaler running with DISTRIBUTOR_DELIVERY_MINUTES=1 (the demo
// setting), e.g. services/distributor under uvicorn on 127.0.0.1:8102. Places a real order with it.

const url = process.env.WHOLESALER_URL ?? "http://127.0.0.1:8102";
const product = (id: string, name: string, unit: string, stockQty: number): Product => ({ id, name, aliases: [], unit, stockQty, reorderLevel: 10, pricePaise: null });

describe.skipIf(process.env.DELIVERY_LIVE !== "1")("a delivery from the real wholesaler agent", () => {
  it("is on its way, then delivered with a note naming the shop's own products", { timeout: 150_000 }, async () => {
    const supplier = createA2ASupplier(url);
    const quote = await supplier.quote(
      [
        { name: "Maggi Noodles", quantity: 11, unit: "packet" },
        { name: "Moong Dal", quantity: 8, unit: "kg" },
      ],
      "Live test shop",
    );
    expect(quote.meetsMinimum).toBe(true);
    const order = await supplier.order(quote.quoteId!);
    const orderedAt = new Date().toISOString();

    const before = await supplier.delivery!({ orderId: order.orderId, quoteId: quote.quoteId!, orderedAt });
    expect(before.status).toBe("on_the_way");
    console.info("on its way:", before);

    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const note = await supplier.delivery!({ orderId: order.orderId, quoteId: quote.quoteId!, orderedAt });
    console.info("delivered:", JSON.stringify(note, null, 2));
    expect(note.status).toBe("delivered");
    if (note.status !== "delivered") return;

    const { received, unplaced } = placeDelivery(note.lines, [product("maggi", "Maggi Noodles", "packet", 9), product("moong", "Moong Dal", "kg", 12)]);
    expect(received.map((r) => [r.product.id, r.quantity])).toEqual([
      ["maggi", 48],
      ["moong", 10],
    ]);
    expect(unplaced).toEqual([]);
  });
});
