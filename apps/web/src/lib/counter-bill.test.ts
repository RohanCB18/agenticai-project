import { describe, expect, it } from "vitest";
import { buildBill, cleanBarcode, isWeighed, lineAmount, looksLikeBarcode, quickQuantities, rupees } from "./counter-bill";

const products = [
  { id: "rice", name: "Rice", unit: "kg" },
  { id: "parle", name: "Parle G", unit: "box" },
  { id: "oil", name: "Sunflower oil", unit: "ltr" },
];

describe("a counter bill", () => {
  it("prices each line by its quantity, and adds them up", () => {
    const bill = buildBill(
      [
        { productId: "rice", quantity: 1.5, pricePaise: 6000 },
        { productId: "parle", quantity: 2, pricePaise: 4500 },
      ],
      products,
    );
    expect(bill).toEqual({
      items: [
        { productId: "rice", name: "Rice", unit: "kg", quantity: 1.5, pricePaise: 6000, amountPaise: 9000 },
        { productId: "parle", name: "Parle G", unit: "box", quantity: 2, pricePaise: 4500, amountPaise: 9000 },
      ],
      totalPaise: 18000,
    });
  });

  it("takes names and units from the shop's products, never the browser", () => {
    const bill = buildBill([{ productId: "oil", quantity: 1, pricePaise: 15000, name: "Gold", unit: "kg" } as never], products);
    expect(bill).toMatchObject({ items: [{ name: "Sunflower oil", unit: "ltr" }] });
  });

  it("makes one line of a product scanned twice", () => {
    const bill = buildBill(
      [
        { productId: "parle", quantity: 1, pricePaise: 4500 },
        { productId: "parle", quantity: 1, pricePaise: 4500 },
      ],
      products,
    );
    expect(bill).toMatchObject({ items: [{ productId: "parle", quantity: 2, amountPaise: 9000 }], totalPaise: 9000 });
  });

  it("refuses what can't be billed", () => {
    expect(buildBill([], products)).toEqual({ error: "The bill is empty." });
    expect(buildBill([{ productId: "gold", quantity: 1, pricePaise: 100 }], products)).toMatchObject({ error: expect.stringContaining("isn't one of this shop's") });
    expect(buildBill([{ productId: "parle", quantity: 1.5, pricePaise: 4500 }], products)).toEqual({ error: "Parle G is sold in whole box." });
    expect(buildBill([{ productId: "rice", quantity: 0, pricePaise: 6000 }], products)).toEqual({ error: "Check the quantity of Rice." });
    expect(buildBill([{ productId: "rice", quantity: 1, pricePaise: 0 }], products)).toEqual({ error: "Add a price for Rice." });
    expect(buildBill([{ productId: "rice", quantity: 1, pricePaise: 12.5 }], products)).toEqual({ error: "Add a price for Rice." });
    expect(buildBill([{ productId: "rice", quantity: 0.01, pricePaise: 50 }], products)).toEqual({ error: "The bill must come to at least ₹1." });
  });
});

describe("the till's helpers", () => {
  it("knows loose goods from packed ones", () => {
    expect(isWeighed("kg")).toBe(true);
    expect(isWeighed("Ltr.")).toBe(true);
    expect(isWeighed("packet")).toBe(false);
    expect(quickQuantities("kg")).toEqual([0.25, 0.5, 1, 2, 5]);
    expect(quickQuantities("g")).toEqual([100, 250, 500, 1000]);
    expect(quickQuantities("box")).toEqual([1, 2, 5, 10]);
  });

  it("rounds a line to the paisa", () => {
    expect(lineAmount(0.333, 6000)).toBe(1998);
  });

  it("reads barcodes, and tells them from a product's name", () => {
    expect(cleanBarcode(" 8901063 010277 ")).toBe("8901063010277");
    expect(cleanBarcode("abc")).toBeNull();
    expect(looksLikeBarcode("8901063010277")).toBe(true);
    expect(looksLikeBarcode("Rice")).toBe(false);
    expect(looksLikeBarcode("450")).toBe(false);
  });

  it("writes rupees the Indian way", () => {
    expect(rupees(123450)).toBe("₹1,234.50");
    expect(rupees(390000)).toBe("₹3,900");
  });
});
