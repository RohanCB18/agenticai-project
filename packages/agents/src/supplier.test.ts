import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createKhataAgent } from "./khata-agent";
import { receiptLines } from "./receipts";
import { latestQuoteId, type QuoteRequestItem, quoteLines, readQuote, SupplierError, type SupplierAgent, type SupplierQuote } from "./supplier";
import { MemoryStore } from "./testing/memory-store";
import { forgetOldToolResults } from "./threads";
import { createKhataTools } from "./tools";

/** A quote id shaped like the wholesaler's: a JWT whose payload anyone can read. */
function token(claims: object) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.signature`;
}

const LINES = [{ item: "Sona Masoori Rice", quantity: 25, unit: "kg", amount: "₹1,300" }];
const QUOTE_ID = token({ lines: LINES, total: "₹1,300", totalPaise: 130_000, deliverySlot: "Sat 14 Nov, 10 am to 1 pm", exp: Date.now() / 1000 + 3600 });

/** A wholesaler that records what it was asked and answers from a script. */
class FakeSupplier implements SupplierAgent {
  readonly name = "Sharma Traders";
  asked: QuoteRequestItem[][] = [];
  ordered: string[] = [];
  fail: Error | null = null;

  async quote(items: QuoteRequestItem[]): Promise<SupplierQuote> {
    if (this.fail) throw this.fail;
    this.asked.push(items);
    return {
      supplier: this.name,
      lines: LINES,
      unavailable: [{ requested: "Ghee", item: "Amul Ghee", reason: "out of stock this week" }],
      total: "₹1,300",
      totalPaise: 130_000,
      discount: null,
      minimumOrder: "₹1,000",
      meetsMinimum: true,
      deliverySlot: "Sat 14 Nov, 10 am to 1 pm",
      payment: "Cash or UPI on delivery",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      quoteId: QUOTE_ID,
    };
  }

  async order(quoteId: string) {
    if (this.fail) throw this.fail;
    this.ordered.push(quoteId);
    return { supplier: this.name, orderId: "ST-1A2B3C4D", lines: LINES, total: "₹1,300", totalPaise: 130_000, deliverySlot: "Sat 14 Nov, 10 am to 1 pm", payment: "Cash or UPI on delivery" };
  }
}

const quotedTurn = (quoteId = QUOTE_ID): ModelMessage[] => [
  { role: "user", content: "Wholesaler se chawal ka rate pucho" },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "q1", toolName: "askSupplierQuote", input: {} }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "q1", toolName: "askSupplierQuote", output: { type: "json", value: { status: "quoted", quoteId } } }] },
  { role: "assistant", content: "Sharma Traders: 25 kg chawal ₹1,300. Order karun?" },
  { role: "user", content: "Haan order karo" },
];
const ctx = (messages: ModelMessage[] = []) => ({ toolCallId: "t1", messages, context: {} }) as never;

let store: MemoryStore;
let supplier: FakeSupplier;
let tools: ReturnType<typeof createKhataTools>;

beforeEach(() => {
  store = new MemoryStore();
  store.products.push(
    { id: "p1", name: "Rice", aliases: ["chawal", "akki"], unit: "kg", stockQty: 50, reorderLevel: 10, pricePaise: 6000 },
    { id: "p2", name: "Sugar", aliases: ["cheeni"], unit: "kg", stockQty: 3, reorderLevel: 5, pricePaise: 4500 },
    { id: "p3", name: "Maggi", aliases: [], unit: "packet", stockQty: 12, reorderLevel: 10, pricePaise: 1400 },
  );
  supplier = new FakeSupplier();
  tools = createKhataTools(store, "Sri Ganesh Stores", { supplier });
});

describe("askSupplierQuote", () => {
  it("quotes everything running low, topped up to twice its reorder level", async () => {
    const out = await tools.askSupplierQuote.execute!({}, ctx());
    expect(supplier.asked).toEqual([[{ name: "Sugar", quantity: 7, unit: "kg" }]]); // 3 kg left, reorder at 5
    expect(out).toMatchObject({ status: "quoted", supplier: "Sharma Traders", total: "₹1,300", lines: [{ item: "Sona Masoori Rice", quantity: "25 kg" }] });
  });

  it("sends the shop's own product names and units for what the owner asked", async () => {
    await tools.askSupplierQuote.execute!({ items: [{ productName: "chawal", quantity: 20 }, { productName: "Ghee", quantity: 2 }] }, ctx());
    expect(supplier.asked[0]).toEqual([
      { name: "Rice", quantity: 20, unit: "kg" },
      { name: "Ghee", quantity: 2 },
    ]);
  });

  it("says so when nothing is low, no wholesaler is connected, or the wholesaler is down", async () => {
    store.products = store.products.filter((p) => p.name !== "Sugar");
    expect(await tools.askSupplierQuote.execute!({}, ctx())).toMatchObject({ status: "nothing_low" });
    expect(await createKhataTools(store).askSupplierQuote.execute!({ items: [{ productName: "Rice", quantity: 25 }] }, ctx())).toMatchObject({ status: "no_supplier" });
    supplier.fail = new Error("ECONNREFUSED");
    expect(await tools.askSupplierQuote.execute!({ items: [{ productName: "Rice", quantity: 25 }] }, ctx())).toMatchObject({ status: "supplier_unavailable" });
  });
});

describe("setReorderLevel", () => {
  it("sets the alert that getStock and restocking use, and 0 removes it", async () => {
    expect(await tools.setReorderLevel.execute!({ productName: "chawal", level: 60 }, ctx())).toEqual({
      status: "alert_set",
      product: "Rice",
      alertAt: "60 kg",
      stock: "50 kg",
      low: true,
    });
    expect(await tools.getStock.execute!({ lowOnly: true }, ctx())).toMatchObject({ products: [{ name: "Rice" }, { name: "Sugar" }] });
    await tools.askSupplierQuote.execute!({}, ctx());
    expect(supplier.asked[0]).toContainEqual({ name: "Rice", quantity: 70, unit: "kg" }); // up to twice the alert level
    expect(await tools.setReorderLevel.execute!({ productName: "Rice", level: 0 }, ctx())).toMatchObject({ status: "alert_set", alertAt: null });
    expect(receiptLines([{ tool: "setReorderLevel", output: { status: "alert_set", product: "Sugar", alertAt: "5 kg", stock: "3 kg" } }])).toEqual(["🧾 Alert: Sugar at 5 kg (now 3 kg)"]);
  });
});

describe("placeSupplierOrder", () => {
  it("orders the quote from the conversation, never one the model typed, and keeps the order", async () => {
    const out = await tools.placeSupplierOrder.execute!({}, ctx(quotedTurn()));
    expect(supplier.ordered).toEqual([QUOTE_ID]);
    expect(out).toMatchObject({ status: "ordered", orderId: "ST-1A2B3C4D", total: "₹1,300" });
    expect(store.supplierOrders).toMatchObject([{ orderId: "ST-1A2B3C4D", quoteId: QUOTE_ID, totalPaise: 130_000 }]);
    await tools.placeSupplierOrder.execute!({}, ctx(quotedTurn()));
    expect(store.supplierOrders).toHaveLength(1); // the wholesaler gives the same order id; it's kept once
  });

  it("needs a live quote first", async () => {
    expect(await tools.placeSupplierOrder.execute!({}, ctx([{ role: "user", content: "order karo" }]))).toMatchObject({ status: "no_quote" });
    const stale = token({ lines: LINES, total: "₹1,300", exp: Date.now() / 1000 - 60 });
    expect(await tools.placeSupplierOrder.execute!({}, ctx(quotedTurn(stale)))).toMatchObject({ status: "quote_expired" });
    expect(supplier.ordered).toEqual([]);
  });

  it("passes on what the wholesaler refused", async () => {
    supplier.fail = new SupplierError("below_minimum", "Orders start at ₹1,000.");
    expect(await tools.placeSupplierOrder.execute!({}, ctx(quotedTurn()))).toEqual({ status: "below_minimum", supplier: "Sharma Traders", message: "Orders start at ₹1,000." });
  });

  it("waits for the owner's button before anything is ordered", async () => {
    const steps: LanguageModelV4GenerateResult[] = [
      { content: [{ type: "tool-call", toolCallId: "o1", toolName: "placeSupplierOrder", input: "{}" }], finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE, warnings: [] },
      { content: [{ type: "text", text: "Order ho gaya." }], finishReason: { unified: "stop", raw: undefined }, usage: USAGE, warnings: [] },
    ];
    let i = 0;
    const agent = createKhataAgent({ model: new MockLanguageModelV4({ doGenerate: async () => steps[i++]! }), store, shopName: "Test", language: "hi", specialists: false, supplier });
    const result = await agent.generate({ messages: quotedTurn() });
    expect(result.content.some((p) => p.type === "tool-approval-request")).toBe(true);
    expect(supplier.ordered).toEqual([]);
  });
});

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };

describe("quotes in the conversation", () => {
  it("reads what a quote id says, for the owner's approval", () => {
    expect(readQuote(QUOTE_ID)).toMatchObject({ total: "₹1,300", deliverySlot: "Sat 14 Nov, 10 am to 1 pm", lines: LINES });
    expect(readQuote("not-a-token")).toBeNull();
    expect(quoteLines(LINES)).toEqual(["• Sona Masoori Rice: 25 kg, ₹1,300"]);
  });

  it("keeps an unanswered quote when older tool results are blanked", () => {
    const kept = forgetOldToolResults(quotedTurn());
    expect(latestQuoteId(kept)).toBe(QUOTE_ID);
  });

  it("gives an order its own receipt line", () => {
    expect(receiptLines([{ tool: "placeSupplierOrder", output: { status: "ordered", orderId: "ST-1", supplier: "Sharma Traders", total: "₹1,300", deliverySlot: "Sat" } }])).toEqual([
      "🚚 Order ST-1 to Sharma Traders: ₹1,300 · delivery Sat",
    ]);
  });
});
