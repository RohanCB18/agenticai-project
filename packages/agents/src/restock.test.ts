import { describe, expect, it } from "vitest";
import { lowProducts, restockAlert, restockItems, restockOrdered } from "./restock";
import type { Product } from "./store";
import type { SupplierOrder, SupplierQuote } from "./supplier";

const product = (name: string, stockQty: number, reorderLevel: number | null, unit = "kg"): Product => ({
  id: name.toLowerCase(),
  name,
  aliases: [],
  unit,
  stockQty,
  reorderLevel,
  pricePaise: null,
});

const rice = product("Rice", 8, 10);
const dal = product("Toor Dal", 5, 5);
const sugar = product("Sugar", 30, 10);
const maggi = product("Maggi", 2, null, "packet");

const quote = (over: Partial<SupplierQuote> = {}): SupplierQuote => ({
  supplier: "Sharma Traders",
  lines: [
    { item: "Sona Masoori Rice", quantity: 25, unit: "kg", amount: "₹1,300" },
    { item: "Toor Dal", quantity: 5, unit: "kg", amount: "₹690" },
  ],
  unavailable: [],
  total: "₹1,990",
  totalPaise: 199000,
  discount: null,
  minimumOrder: "₹1,000",
  meetsMinimum: true,
  deliverySlot: "Fri 28 Nov, 10 am to 1 pm",
  payment: "Cash or UPI on delivery",
  validUntil: "2026-11-27T10:00:00Z",
  quoteId: "a.b.c",
  ...over,
});

describe("what is low, and how much to order", () => {
  it("counts only products at or below the alert the owner set", () => {
    expect(lowProducts([rice, dal, sugar, maggi]).map((p) => p.name)).toEqual(["Rice", "Toor Dal"]);
  });

  it("tops each up to twice its alert level", () => {
    expect(restockItems([rice, dal, sugar, maggi])).toEqual([
      { name: "Rice", quantity: 12, unit: "kg" },
      { name: "Toor Dal", quantity: 5, unit: "kg" },
    ]);
  });
});

describe("the restock ask", () => {
  it("shows what is low, the quote, and what one haan does", () => {
    const { text, canOrder } = restockAlert([rice, dal], quote(), { to: "UPI su•••@upi", fromBalance: true });
    expect(canOrder).toBe(true);
    expect(text).toContain("📦 Running low: Rice 8 kg left (alert at 10 kg), Toor Dal 5 kg left (alert at 5 kg).");
    expect(text).toContain("• Sona Masoori Rice: 25 kg, ₹1,300");
    expect(text).toContain("Total ₹1,990 · delivery Fri 28 Nov, 10 am to 1 pm");
    expect(text).toContain("Haan: Munshi places this order and pays Sharma Traders ₹1,990 from your Cashfree balance (to UPI su•••@upi).");
    expect(text).toContain("If the balance can't, you get a Cashfree page to pay instead.");
  });

  it("offers the page to pay when Munshi can't pay from the balance", () => {
    expect(restockAlert([rice], quote(), { to: "UPI su•••@upi", fromBalance: false }).text).toContain(
      "Haan: Munshi places this order and sends you a Cashfree page to pay Sharma Traders ₹1,990 (it goes to UPI su•••@upi).",
    );
  });

  it("orders to pay on delivery when the supplier has no account in Munshi", () => {
    expect(restockAlert([rice], quote(), null).text).toContain("to pay on delivery. To pay through Munshi, add Sharma Traders' account on the Suppliers page.");
  });

  it("offers nothing to order under the wholesaler's minimum, or when it can't supply", () => {
    expect(restockAlert([rice], quote({ meetsMinimum: false, total: "₹600" }), null)).toMatchObject({
      canOrder: false,
      text: expect.stringContaining("Orders start at ₹1,000"),
    });
    const none = restockAlert([dal], quote({ lines: [], quoteId: undefined, unavailable: [{ requested: "Ghee", reason: "out of stock this week" }] }), null);
    expect(none.canOrder).toBe(false);
    expect(none.text).toContain("Can't supply: Ghee (out of stock this week).");
    expect(restockAlert([rice], null, null)).toMatchObject({ canOrder: false, text: expect.stringContaining("No wholesaler is connected") });
  });
});

describe("after haan", () => {
  const order: SupplierOrder = { supplier: "Sharma Traders", orderId: "ST-1A2B", lines: [], total: "₹1,990", totalPaise: 199000, deliverySlot: "Fri 28 Nov", payment: "" };

  it("gives the order and the payment from the balance", () => {
    const paid = restockOrdered(order, { status: "paid", to: "UPI su•••@upi", utr: "UTR9" });
    expect(paid).toContain("✅ Order ST-1A2B placed with Sharma Traders: ₹1,990, delivery Fri 28 Nov.");
    expect(paid).toContain("💸 Paid ₹1,990 to Sharma Traders from your Cashfree balance (to UPI su•••@upi). UTR UTR9.");
    expect(restockOrdered(order, { status: "started", to: "UPI su•••@upi" })).toContain("Munshi tells you as soon as it reaches them.");
  });

  it("gives the page to pay when the balance couldn't, and says why", () => {
    expect(restockOrdered(order, { status: "page", url: "https://pay.example/x", to: "UPI su•••@upi" })).toContain("💸 Pay ₹1,990 to Sharma Traders here: https://pay.example/x");
    expect(restockOrdered(order, { status: "page", url: "https://pay.example/x", to: "UPI su•••@upi", because: "not enough money in your Cashfree Payouts balance" })).toContain(
      "💸 Your Cashfree balance couldn't pay it (not enough money in your Cashfree Payouts balance), so pay ₹1,990 to Sharma Traders here: https://pay.example/x",
    );
  });

  it("says plainly when nothing was paid", () => {
    expect(restockOrdered(order, null)).toContain("Pay on delivery.");
    expect(restockOrdered(order, { status: "failed", error: "Cashfree was down" })).toContain("Nothing was paid");
  });
});
