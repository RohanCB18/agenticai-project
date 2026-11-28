import { describe, expect, it } from "vitest";
import { defaultAlertLevel, lowProducts, nextToRunLow, paiseOf, plainYesNo, restockAlert, restockItems, restockOrdered } from "./restock";
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

describe("alert levels nobody set", () => {
  it("gives every product a level by its unit", () => {
    expect(defaultAlertLevel("kg")).toBe(10);
    expect(defaultAlertLevel(" KG ")).toBe(10);
    expect(defaultAlertLevel("ltr")).toBe(5);
    expect(defaultAlertLevel("litre")).toBe(5);
    expect(defaultAlertLevel("packet")).toBe(10);
    expect(defaultAlertLevel("pkt.")).toBe(10);
    expect(defaultAlertLevel("box")).toBe(2);
    expect(defaultAlertLevel("bottle")).toBe(6);
    expect(defaultAlertLevel("g")).toBe(1000);
    expect(defaultAlertLevel("crate")).toBe(5); // a unit Munshi doesn't know
  });

  it("says when the level is Munshi's default, so the owner knows they can change it", () => {
    const parle: Product = { ...product("Parle G", 2, 2, "box"), alertIsDefault: true };
    expect(restockAlert([parle], quote(), null).text).toContain("Parle G 2 box left (alert at 2 box, Munshi's default)");
  });
});

describe("a typed or spoken answer to the ask", () => {
  it("takes a plain haan or nahi, in Hindi, Kannada or English, with any punctuation", () => {
    for (const yes of ["haan", "Haan.", "haan ji", "Ha!", "हाँ।", "हां जी", "ಹೌದು", "houdu", "ok", "Yes", "order kar do", "👍 haan"]) expect(plainYesNo(yes)).toBe(true);
    for (const no of ["nahi", "Nahin.", "no", "नहीं", "ಬೇಡ", "illa", "abhi nahi"]) expect(plainYesNo(no)).toBe(false);
  });

  it("leaves anything more to the agent", () => {
    for (const other of ["haan, 2 bag aur", "Ramesh ne 200 diye", "kitna hai?", "", "haan nahi"]) expect(plainYesNo(other)).toBeNull();
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

describe("filling an order up to the wholesaler's minimum", () => {
  it("takes what runs low next, closest to its alert level first", () => {
    const moong = product("Moong Dal", 12, 10);
    const atta = product("Atta", 16, 10);
    const salt = product("Salt", 25, 10); // over twice its level: not due for a while
    const none = product("Matchbox", 3, null, "box"); // no level: never counted
    expect(nextToRunLow([atta, rice, salt, moong, none, sugar]).map((p) => p.name)).toEqual(["Moong Dal", "Atta"]);
    expect(nextToRunLow([atta, moong], new Set(["moong dal"])).map((p) => p.name)).toEqual(["Atta"]);
  });

  it("reads rupee amounts", () => {
    expect(paiseOf("₹1,000")).toBe(100000);
    expect(paiseOf("₹1,160.50")).toBe(116050);
    expect(paiseOf("free")).toBeNull();
  });

  it("says what was added, and why, before the quote", () => {
    const maggiLow = { ...product("Maggi Noodles", 9, 10, "packet"), alertIsDefault: true };
    const moong = product("Moong Dal", 12, 10);
    const { text, canOrder } = restockAlert([maggiLow], quote({ total: "₹1,736", totalPaise: 173600 }), { to: "UPI su•••@upi", fromBalance: true }, undefined, [moong]);
    expect(canOrder).toBe(true);
    expect(text.split("\n").slice(0, 2)).toEqual([
      "📦 Running low: Maggi Noodles 9 packet left (alert at 10 packet, Munshi's default).",
      "Sharma Traders' minimum order is ₹1,000, so I added what runs low next: Moong Dal 12 kg left (alert at 10 kg).",
    ]);
  });
});
