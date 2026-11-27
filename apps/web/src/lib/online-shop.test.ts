import { describe, expect, it } from "vitest";
import { orderMessage } from "./online-shop";
import { stillAsked } from "./restock";

describe("the owner's message about an online order", () => {
  it("says what to pack, for whom, and whether it's paid", () => {
    const text = orderMessage({
      items: [
        { productId: "rice", name: "Sona Masoori Rice", unit: "kg", quantity: 2, pricePaise: 6200, amountPaise: 12400 },
        { productId: "parle", name: "Parle-G Biscuits", unit: "packet", quantity: 3, pricePaise: 1000, amountPaise: 3000 },
      ],
      totalPaise: 15400,
      method: "upi",
      buyerName: "Priya",
      buyerPhone: "9845012345",
      address: "12, 4th Cross, Jayanagar",
    });
    expect(text).toBe(
      [
        "🛒 New online order, ₹154, from Priya (98•••••345)",
        "• Sona Masoori Rice × 2 kg",
        "• Parle-G Biscuits × 3 packet",
        "✅ Paid by UPI",
        "📍 12, 4th Cross, Jayanagar",
        "Stock is updated.",
      ].join("\n"),
    );
  });

  it("marks cash on delivery, and leaves out a missing address", () => {
    const text = orderMessage({
      items: [{ productId: "milk", name: "Milk", unit: "packet", quantity: 1, pricePaise: 2600, amountPaise: 2600 }],
      totalPaise: 2600,
      method: "cash",
      buyerName: "Ravi",
      buyerPhone: "9000000001",
      address: null,
    });
    expect(text).toContain("💵 Cash on delivery");
    expect(text).not.toContain("📍");
  });
});

describe("restock asks", () => {
  const ask = (ids: string[], at: string) => ({ productIds: ids, at });

  it("cover a product until stock comes in for it", () => {
    const asks = [ask(["rice", "oil"], "2026-11-27T10:00:00Z")];
    expect(stillAsked(asks, [])).toEqual(new Set(["rice", "oil"]));
    // Rice came in after the ask: when it runs low again, Munshi asks again.
    expect(stillAsked(asks, [{ productId: "rice", at: "2026-11-27T12:00:00Z" }])).toEqual(new Set(["oil"]));
  });

  it("ignore stock that came in before the latest ask", () => {
    const asks = [ask(["rice"], "2026-11-27T10:00:00Z"), ask(["rice"], "2026-11-27T14:00:00Z")];
    expect(stillAsked(asks, [{ productId: "rice", at: "2026-11-27T12:00:00Z" }])).toEqual(new Set(["rice"]));
  });
});
