import { describe, expect, it } from "vitest";
import { buildBill } from "./counter-bill";
import { aisleOf, alreadySells, canOrder, cartToLines, checkBuyer, fewLeft, maskPhone, orderStep, SAMPLE_PRODUCTS, shopSlug } from "./shop";

const rice = { id: "rice", name: "Sona Masoori Rice", unit: "kg", stock: 12.4, pricePaise: 6200 };
const parle = { id: "parle", name: "Parle-G Biscuits", unit: "packet", stock: 3, pricePaise: 1000 };
const ghee = { id: "ghee", name: "Amul Ghee", unit: "ltr", stock: 0, pricePaise: 72000 };
const unpriced = { id: "sugar", name: "Sugar", unit: "kg", stock: 20, pricePaise: null };

describe("the store's address", () => {
  it("comes from the shop's name", () => {
    expect(shopSlug("RCB General Stores")).toBe("rcb-general-stores");
    expect(shopSlug("  Lakshmi's  Super-Market!! ")).toBe("lakshmi-s-super-market");
    expect(shopSlug("ಲಕ್ಷ್ಮಿ")).toBe("shop");
  });
});

describe("aisles", () => {
  it("put products where a customer looks for them", () => {
    expect(aisleOf("Sona Masoori Rice")).toEqual({ aisle: "staples", emoji: "🍚" });
    expect(aisleOf("Nandini Milk 500ml")).toEqual({ aisle: "dairy", emoji: "🥛" });
    expect(aisleOf("Amul Ghee")).toEqual({ aisle: "oil", emoji: "🧈" });
    expect(aisleOf("Amul Butter 100g")).toEqual({ aisle: "dairy", emoji: "🧈" });
    expect(aisleOf("Parle-G Biscuits")).toMatchObject({ aisle: "snacks" });
    expect(aisleOf("Lifebuoy Soap")).toMatchObject({ aisle: "care" });
    expect(aisleOf("Surf Excel")).toMatchObject({ aisle: "home" });
  });

  it("use the owner's other names, and fall back to More", () => {
    expect(aisleOf("Akki", ["rice"])).toMatchObject({ aisle: "staples" });
    expect(aisleOf("Matchbox")).toEqual({ aisle: "more", emoji: "🛒" });
  });

  it("place every sample product somewhere better than More", () => {
    expect(SAMPLE_PRODUCTS.filter((p) => aisleOf(p.name, p.aliases).aisle === "more").map((p) => p.name)).toEqual([]);
  });
});

describe("what a customer can order", () => {
  it("is what's on the shelf, in whole steps", () => {
    expect(canOrder(12.4, "kg")).toBe(12);
    expect(canOrder(0.6, "kg")).toBe(0);
    expect(canOrder(-2, "packet")).toBe(0);
    expect(canOrder(750, "g")).toBe(700);
    expect(orderStep("g")).toBe(100);
    expect(fewLeft(3, "packet")).toBe(true);
    expect(fewLeft(30, "packet")).toBe(false);
    expect(fewLeft(0, "packet")).toBe(false);
  });

  it("is priced by the shop, never the browser", () => {
    const lines = cartToLines(
      [
        { productId: "rice", quantity: 2 },
        { productId: "parle", quantity: 1 },
        { productId: "rice", quantity: 1 },
      ],
      [rice, parle],
    );
    expect(lines).toEqual([
      { productId: "rice", quantity: 3, pricePaise: 6200 },
      { productId: "parle", quantity: 1, pricePaise: 1000 },
    ]);
    const bill = buildBill(lines as never, [rice, parle]);
    expect(bill).toMatchObject({ totalPaise: 19600 });
  });

  it("refuses more than the shelf has, sold-out goods, unpriced goods and odd amounts", () => {
    expect(cartToLines([{ productId: "parle", quantity: 4 }], [parle])).toEqual({ error: "Only 3 packet of Parle-G Biscuits left. Lower it to place the order." });
    expect(cartToLines([{ productId: "ghee", quantity: 1 }], [ghee])).toEqual({ error: "Amul Ghee just sold out. Remove it to place the order." });
    expect(cartToLines([{ productId: "sugar", quantity: 1 }], [unpriced])).toMatchObject({ error: expect.stringContaining("isn't sold here") });
    expect(cartToLines([{ productId: "other-shop", quantity: 1 }], [rice])).toMatchObject({ error: expect.stringContaining("isn't sold here") });
    expect(cartToLines([{ productId: "rice", quantity: 0.5 }], [rice])).toEqual({ error: "Check how much Sona Masoori Rice you want." });
    expect(cartToLines([], [rice])).toEqual({ error: "Your cart is empty." });
  });
});

describe("the customer's details", () => {
  it("take a 10-digit mobile, with or without +91", () => {
    expect(checkBuyer({ name: " Priya  S ", phone: "+91 98450 12345", address: " 12, 4th Cross " })).toEqual({ name: "Priya S", phone: "9845012345", address: "12, 4th Cross" });
    expect(checkBuyer({ name: "Priya", phone: "09845012345" })).toEqual({ name: "Priya", phone: "9845012345", address: null });
  });

  it("say what to fix", () => {
    expect(checkBuyer({ name: "P", phone: "9845012345" })).toEqual({ error: "Tell the shop your name." });
    expect(checkBuyer({ name: "Priya", phone: "12345" })).toEqual({ error: "Enter a 10-digit mobile number." });
    expect(checkBuyer({ name: "Priya", phone: "5845012345" })).toEqual({ error: "Enter a 10-digit mobile number." });
  });

  it("show the owner only enough of the number", () => {
    expect(maskPhone("9845012345")).toBe("98•••••345");
  });
});

describe("the sample range", () => {
  it("skips what the shop already sells, by any name", () => {
    const sugar = SAMPLE_PRODUCTS.find((p) => p.name === "Sugar")!;
    const parleG = SAMPLE_PRODUCTS.find((p) => p.name === "Parle-G Biscuits")!;
    expect(alreadySells(sugar, [{ name: "sugar", aliases: [] }])).toBe(true);
    expect(alreadySells(parleG, [{ name: "Parle G", aliases: [] }])).toBe(true);
    expect(alreadySells(parleG, [{ name: "Good Day", aliases: [] }])).toBe(false);
  });

  it("starts each item a few orders above its alert level", async () => {
    const { defaultAlertLevel } = await import("@munshi/agents");
    for (const p of SAMPLE_PRODUCTS) expect(p.stock, p.name).toBeGreaterThan(defaultAlertLevel(p.unit));
  });
});
