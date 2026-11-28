import { describe, expect, it } from "vitest";
import { deliveryMessage, placeDelivery, sameUnit } from "./deliveries";
import type { Product } from "./store";
import type { SupplierLine } from "./supplier";

const product = (id: string, name: string, unit: string, stockQty: number, aliases: string[] = []): Product => ({ id, name, aliases, unit, stockQty, reorderLevel: 10, pricePaise: null });
const line = (item: string, quantity: number, unit: string, requested?: string): SupplierLine => ({ item, quantity, unit, amount: "₹0", ...(requested ? { requested } : {}) });

const maggi = product("maggi", "Maggi Noodles", "packet", 9);
const moong = product("moong", "Moong Dal", "kg", 12);
const oil = product("oil", "Sunflower oil", "ltr", 4);
const parle = product("parle", "Parle G", "box", 1);
const products = [maggi, moong, oil, parle];

describe("units", () => {
  it("match when they mean the same measure", () => {
    expect(sameUnit("litre", "ltr")).toBe(true);
    expect(sameUnit("Packets", "pkt")).toBe(true);
    expect(sameUnit("kg", "kgs")).toBe(true);
    expect(sameUnit("packet", "box")).toBe(false);
    expect(sameUnit("kg", "g")).toBe(false);
  });
});

describe("a delivery note, placed on the shop's products", () => {
  it("goes by the shop's own name for each line, sent when it was ordered", () => {
    const { received, unplaced } = placeDelivery([line("Maggi Noodles", 48, "packet", "Maggi Noodles"), line("Moong Dal", 10, "kg", "Moong Dal")], products);
    expect(received.map((r) => [r.product.id, r.quantity])).toEqual([
      ["maggi", 48],
      ["moong", 10],
    ]);
    expect(unplaced).toEqual([]);
  });

  it("finds the product by a close name when the note has none, in the same unit", () => {
    // An order placed before notes carried the shop's names: "Sunflower Oil" in litres is the shop's "Sunflower oil" in ltr.
    const { received } = placeDelivery([line("Sunflower Oil", 15, "litre")], products);
    expect(received.map((r) => [r.product.id, r.quantity])).toEqual([["oil", 15]]);
  });

  it("leaves out what it can't place safely, and says why", () => {
    const { received, unplaced } = placeDelivery([line("Parle-G Biscuits", 60, "packet", "Parle G"), line("Tata Salt", 25, "kg", "Tata Salt")], products);
    expect(received).toEqual([]);
    expect(unplaced.map((u) => u.why)).toEqual(["your Parle G is counted in box", "isn't one of your products"]);
  });

  it("adds up the same product delivered twice", () => {
    const { received } = placeDelivery([line("Moong Dal", 5, "kg", "Moong Dal"), line("Moong Dal", 5, "kg", "Moong Dal")], products);
    expect(received.map((r) => [r.product.id, r.quantity])).toEqual([["moong", 10]]);
  });
});

describe("the owner's message", () => {
  it("says what came, the shelf before and after, and how to report a short delivery", () => {
    const { received, unplaced } = placeDelivery(
      [line("Maggi Noodles", 48, "packet", "Maggi Noodles"), line("Moong Dal", 10, "kg", "Moong Dal"), line("Parle-G Biscuits", 60, "packet", "Parle G")],
      products,
    );
    expect(deliveryMessage({ supplier: "Sharma Traders", orderId: "ST-1A2B3C4D", invoiceNo: "INV-1A2B3C4D", total: "₹1,736" }, received, unplaced)).toBe(
      [
        "🚚 Sharma Traders delivered order ST-1A2B3C4D (invoice INV-1A2B3C4D, ₹1,736).",
        "Added to stock:",
        "• Maggi Noodles +48 packet: 9 → 57",
        "• Moong Dal +10 kg: 12 → 22",
        "Not added, tell me how much to add:",
        "• Parle-G Biscuits 60 packet (your Parle G is counted in box)",
        'If anything came short or damaged, tell me, like "Maggi Noodles 24 packet hi aaya".',
      ].join("\n"),
    );
  });
});
