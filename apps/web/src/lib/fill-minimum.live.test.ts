import { type Product, restockAlert, topUpItem } from "@munshi/agents";
import { describe, expect, it } from "vitest";
import { fillToMinimum } from "./restock";
import { createA2ASupplier } from "./supplier";

// Against the real demo wholesaler (services/distributor, deployed as munshi-wholesaler): a quote
// only, nothing is ordered. FILL_LIVE=1 to run; WHOLESALER_URL to point elsewhere.
// Live on 28 Nov, 48 Maggi (₹576) were under its ₹1,000 minimum and nothing could be ordered.

const url = process.env.WHOLESALER_URL ?? "https://munshi-wholesaler.vercel.app";
const item = (id: string, name: string, unit: string, stockQty: number): Product => ({ id, name, aliases: [], unit, stockQty, reorderLevel: 10, alertIsDefault: true, pricePaise: null });

describe.skipIf(process.env.FILL_LIVE !== "1")("filling a short order with the real wholesaler", () => {
  it("adds what runs low next until Sharma Traders' minimum is met", { timeout: 60_000 }, async () => {
    const supplier = createA2ASupplier(url);
    const maggi = item("maggi", "Maggi Noodles", "packet", 9);
    const products = [maggi, item("bread", "Brown Bread", "packet", 11), item("moong", "Moong Dal", "kg", 12), item("toor", "Toor Dal", "kg", 13), item("rice", "Sona Masoori Rice", "kg", 18)];

    const short = await supplier.quote([topUpItem(maggi)], "Live test shop");
    expect(short.meetsMinimum).toBe(false);

    const { quote, added } = await fillToMinimum(supplier, "Live test shop", [maggi], products, short);
    console.info(restockAlert([maggi], quote, { to: "UPI su•••@upi", fromBalance: true }, undefined, added).text);
    expect(quote.meetsMinimum).toBe(true);
    expect(quote.quoteId).toBeTruthy();
    expect(added.map((p) => p.name)).not.toContain("Brown Bread"); // Sharma Traders doesn't sell bread
    expect(added.length).toBeGreaterThan(0);
  });
});
