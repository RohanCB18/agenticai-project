import { describe, expect, it } from "vitest";
import { rankProducts } from "./staples";
import { MemoryStore } from "./testing/memory-store";
import { createKhataTools } from "./tools";

const product = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases, unit: "kg", stockQty: 50, reorderLevel: 10, pricePaise: null });
const products = [product("rice", "Rice"), product("sugar", "Sugar"), product("maggi", "Maggi"), product("sona", "Sona Masoori Rice"), product("atta", "Aashirvaad Atta")];
const top = (query: string) => rankProducts(query, products).map((m) => m.item.id);

describe("staple names", () => {
  it("finds a product by its everyday name in any language", () => {
    expect(top("akki")).toContain("rice"); // Kannada
    expect(top("chawal")).toContain("rice"); // Hindi
    expect(top("arisi")).toContain("rice"); // Tamil
    expect(top("sakkare")[0]).toBe("sugar");
    expect(top("cheeni")[0]).toBe("sugar");
  });

  it("works across scripts", () => {
    expect(top("ಅಕ್ಕಿ")).toContain("rice");
    expect(top("चावल")).toContain("rice");
  });

  it("knows a product by the staple in its name", () => {
    expect(top("akki")).toContain("sona");
    expect(top("gehun ka atta")).toContain("atta");
  });

  it("doesn't make unrelated products match", () => {
    expect(top("akki")).not.toContain("maggi");
    expect(top("akki")).not.toContain("sugar");
    expect(top("Ramesh")).toEqual([]);
  });
});

describe("stock tools with staple names", () => {
  it("answers 'akki eshtu ide' and updates the right product", async () => {
    const store = new MemoryStore();
    store.products.push(product("rice", "Rice"));
    const tools = createKhataTools(store);
    const ctx = { toolCallId: "t1", messages: [], context: {} } as never;
    expect(await tools.getStock.execute!({ productName: "akki", lowOnly: false }, ctx)).toMatchObject({ products: [{ name: "Rice", stock: "50 kg" }] });
    expect(await tools.updateStock.execute!({ productName: "ಅಕ್ಕಿ", change: 10, reason: "purchase" }, ctx)).toMatchObject({ status: "updated", product: "Rice", stock: "60 kg" });
  });
});

describe("updateStock with two products that fit", () => {
  it("asks which one instead of picking", async () => {
    const store = new MemoryStore();
    store.products.push(product("rice", "Rice"), product("sona", "Sona Masoori Rice"));
    const tools = createKhataTools(store);
    const ctx = { toolCallId: "t1", messages: [], context: {} } as never;
    expect(await tools.updateStock.execute!({ productName: "akki", change: 10, reason: "purchase" }, ctx)).toMatchObject({ status: "ambiguous_product" });
    expect(store.products.map((p) => p.stockQty)).toEqual([50, 50]);
    // The product's own name is still certain.
    expect(await tools.updateStock.execute!({ productName: "Sona Masoori Rice", change: 5, reason: "purchase" }, ctx)).toMatchObject({ status: "updated", stock: "55 kg" });
  });
});
