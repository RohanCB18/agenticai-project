import type { SupplierAgent, SupplierOrder, SupplierQuote } from "@munshi/agents";
import { MemoryStore } from "@munshi/agents/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerRestock, askToRestock, type OwnerChats, RESTOCK_APPROVAL_PREFIX, type RestockBook } from "./restock";
import { createA2ASupplier } from "./supplier";

// The whole restock loop with fakes for the database, the chat apps and the wholesaler: stock runs
// low → one ask with the quote → "haan" → the order is placed and the page to pay it is made.

const NOW = new Date("2026-11-26T10:00:00Z");
const DAY = 24 * 60 * 60_000;

/** A quote id readQuote can read (an unsigned JWT is enough for showing; the wholesaler checks it). */
function quoteId(expires: Date) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ lines: [], total: "₹1,990", deliverySlot: "Fri", exp: Math.floor(expires.getTime() / 1000) })}.sig`;
}

function wholesaler(over: { quote?: Partial<SupplierQuote>; orderFails?: boolean } = {}) {
  const asked: { items: unknown; shop: string }[] = [];
  const ordered: string[] = [];
  const agent: SupplierAgent = {
    name: "Sharma Traders",
    async quote(items, shop) {
      asked.push({ items, shop });
      return {
        supplier: "Sharma Traders",
        lines: [{ item: "Sona Masoori Rice", quantity: 25, unit: "kg", amount: "₹1,300" }],
        unavailable: [],
        total: "₹1,990",
        totalPaise: 199000,
        discount: null,
        minimumOrder: "₹1,000",
        meetsMinimum: true,
        deliverySlot: "Fri 28 Nov, 10 am to 1 pm",
        payment: "Cash or UPI on delivery",
        validUntil: new Date(NOW.getTime() + DAY).toISOString(),
        quoteId: quoteId(new Date(NOW.getTime() + DAY)),
        ...over.quote,
      };
    },
    async order(id): Promise<SupplierOrder> {
      if (over.orderFails) throw new Error("This quote has expired. Ask for a fresh one.");
      ordered.push(id);
      return { supplier: "Sharma Traders", orderId: "ST-1A2B", lines: [], total: "₹1,990", totalPaise: 199000, deliverySlot: "Fri 28 Nov", payment: "Cash or UPI on delivery" };
    },
  };
  return { agent, asked, ordered };
}

/** approvals rows, in memory. */
function memoryBook() {
  const rows: { id: string; status: string; productIds: string[]; quoteId: string | null; expiresAt: string; createdAt: Date; note: Record<string, unknown> }[] = [];
  let next = 0;
  let clock = NOW;
  const book: RestockBook = {
    async askedSince(since) {
      return new Set(rows.filter((r) => r.createdAt >= since && !r.note.quoteExpired).flatMap((r) => r.productIds));
    },
    async open({ productIds, quoteId, expiresAt, offered }) {
      const id = `req${++next}`;
      rows.push({ id, status: offered ? "pending" : "expired", productIds, quoteId, expiresAt: expiresAt.toISOString(), createdAt: clock, note: {} });
      return id;
    },
    async pending(id) {
      const row = rows.find((r) => r.id === id && r.status === "pending");
      return row ? { id: row.id, quoteId: row.quoteId, expiresAt: row.expiresAt } : null;
    },
    async claim(id) {
      const row = rows.find((r) => r.id === id && r.status === "pending");
      if (!row) return false;
      row.status = "approved";
      return true;
    },
    async close(id, status, note) {
      const row = rows.find((r) => r.id === id)!;
      row.status = status;
      Object.assign(row.note, note);
    },
  };
  return { book, rows, setClock: (d: Date) => (clock = d) };
}

function memoryChats(count = 1) {
  const asks: { text: string; approvalId: string; yes: string }[] = [];
  const told: string[] = [];
  const chats: OwnerChats = {
    count,
    ask: async (text, approvalId, labels) => void asks.push({ text, approvalId, yes: labels.yes }),
    tell: async (text) => void told.push(text),
  };
  return { chats, asks, told };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  store.products = [
    { id: "rice", name: "Rice", aliases: [], unit: "kg", stockQty: 8, reorderLevel: 10, pricePaise: null },
    { id: "sugar", name: "Sugar", aliases: [], unit: "kg", stockQty: 30, reorderLevel: 10, pricePaise: null },
  ];
  store.suppliers = [{ id: "sup_1", name: "SHARMA TRADERS", aliases: [], account: "UPI su•••@upi", verified: true }];
});

describe("asking to restock", () => {
  it("asks once, with the quote for what is low topped up to twice its alert, and a Haan button", async () => {
    const { agent, asked } = wholesaler();
    const { book } = memoryBook();
    const { chats, asks } = memoryChats();

    expect(await askToRestock({ store, book, chats, supplier: agent, shopName: "RCB general stores", now: NOW })).toBe("asked");
    expect(asked).toEqual([{ items: [{ name: "Rice", quantity: 12, unit: "kg" }], shop: "RCB general stores" }]);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.approvalId).toBe(`${RESTOCK_APPROVAL_PREFIX}req1`);
    expect(asks[0]!.yes).toBe("✅ Haan, order + pay");
    expect(asks[0]!.text).toContain("Rice 8 kg left (alert at 10 kg)");

    // After every later message, nothing new: no nagging about the same rice for 3 days.
    expect(await askToRestock({ store, book, chats, supplier: agent, shopName: "RCB", now: new Date(NOW.getTime() + DAY) })).toBe("none");
    expect(await askToRestock({ store, book, chats, supplier: agent, shopName: "RCB", now: new Date(NOW.getTime() + 4 * DAY) })).toBe("asked");
  });

  it("stays quiet when nothing is low, or there is no chat app to ask on", async () => {
    const { agent } = wholesaler();
    store.products[0]!.stockQty = 20;
    expect(await askToRestock({ store, book: memoryBook().book, chats: memoryChats().chats, supplier: agent, shopName: "RCB", now: NOW })).toBe("none");
    store.products[0]!.stockQty = 8;
    expect(await askToRestock({ store, book: memoryBook().book, chats: memoryChats(0).chats, supplier: agent, shopName: "RCB", now: NOW })).toBe("none");
  });

  it("only tells, without a button, when there is nothing one haan could order", async () => {
    const { agent } = wholesaler({ quote: { meetsMinimum: false, total: "₹600" } });
    const { chats, asks, told } = memoryChats();
    expect(await askToRestock({ store, book: memoryBook().book, chats, supplier: agent, shopName: "RCB", now: NOW })).toBe("told");
    expect(asks).toHaveLength(0);
    expect(told[0]).toContain("Orders start at ₹1,000");
  });
});

describe("the owner's tap", () => {
  async function asked(over?: Parameters<typeof wholesaler>[0]) {
    const w = wholesaler(over);
    const b = memoryBook();
    const c = memoryChats();
    await askToRestock({ store, book: b.book, chats: c.chats, supplier: w.agent, shopName: "RCB", now: NOW });
    return { ...w, ...b, approvalId: c.asks[0]!.approvalId };
  }

  it("haan: orders exactly the quote shown, keeps the order, and makes the page to pay it", async () => {
    const { agent, book, rows, ordered, approvalId } = await asked();
    const answer = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);

    expect(ordered).toEqual([rows[0]!.quoteId]);
    expect(store.supplierOrders.map((o) => o.orderId)).toEqual(["ST-1A2B"]);
    expect(store.payouts).toEqual([expect.objectContaining({ supplierId: "sup_1", amountPaise: 199000, supplierOrderId: "ST-1A2B" })]);
    expect(answer.text).toContain("✅ Order ST-1A2B placed with Sharma Traders");
    expect(answer.text).toContain("💸 Pay ₹1,990 to Sharma Traders here: https://payments-test.cashfree.com/links/sup_1");
    expect(answer.buttons).toEqual([{ text: "Pay ₹1,990 to Sharma Traders", url: "https://payments-test.cashfree.com/links/sup_1" }]);
    expect(rows[0]).toMatchObject({ status: "executed", note: { orderId: "ST-1A2B" } });
  });

  it("haan with Cashfree Payouts: pays from the balance, with no page and nothing more to tap", async () => {
    const { agent, book, approvalId } = await asked();
    store.payoutStatus = "success";
    const paid = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(paid.text).toContain("💸 Paid ₹1,990 to Sharma Traders from your Cashfree balance (to UPI su•••@upi). UTR UTR123.");
    expect(paid.buttons).toBeUndefined();
    expect(paid.paying).toBeUndefined();
  });

  it("haan while Cashfree is still sending: says so, and asks to be watched", async () => {
    const { agent, book, approvalId } = await asked();
    store.payoutVia = "balance";
    const started = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(started.text).toContain("💸 Paying ₹1,990 to Sharma Traders from your Cashfree balance");
    expect(started).toMatchObject({ paying: true });
  });

  it("haan when the balance couldn't pay: the page to pay instead, and why", async () => {
    const { agent, book, approvalId } = await asked();
    store.balanceFailed = "not enough money in your Cashfree Payouts balance";
    const answer = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(answer.text).toContain("Your Cashfree balance couldn't pay it (not enough money in your Cashfree Payouts balance), so pay ₹1,990 to Sharma Traders here:");
    expect(answer.buttons).toHaveLength(1);
  });

  it("the ask says the balance pays when Payouts is set up", async () => {
    const { chats, asks } = memoryChats();
    await askToRestock({ store, book: memoryBook().book, chats, supplier: wholesaler().agent, shopName: "RCB", fromBalance: true, now: NOW });
    expect(asks[0]!.text).toContain("pays Sharma Traders ₹1,990 from your Cashfree balance (to UPI su•••@upi)");
  });

  it("a second tap does nothing", async () => {
    const { agent, book, ordered, approvalId } = await asked();
    await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true)).toMatchObject({ text: expect.stringContaining("already answered") });
    expect(ordered).toHaveLength(1);
    expect(store.payouts).toHaveLength(1);
  });

  it("nahi: nothing is ordered or paid", async () => {
    const { agent, book, rows, ordered, approvalId } = await asked();
    expect((await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, false)).text).toContain("not ordering");
    expect(ordered).toHaveLength(0);
    expect(store.payouts).toHaveLength(0);
    expect(rows[0]!.status).toBe("rejected");
  });

  it("a quote that ran out isn't ordered, and a fresh ask follows", async () => {
    const { agent, book, rows, ordered, approvalId } = await asked();
    const answer = await answerRestock({ store, book, supplier: agent, now: new Date(NOW.getTime() + 2 * DAY) }, approvalId, true);
    expect(answer).toMatchObject({ askAgain: true });
    expect(ordered).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: "expired", note: { quoteExpired: true } });
    // The ran-out ask doesn't block the fresh one.
    expect((await book.askedSince(new Date(NOW.getTime() - DAY))).has("rice")).toBe(false);
  });

  it("when the wholesaler refuses, nothing is paid", async () => {
    const { agent, book, rows, approvalId } = await asked({ orderFails: true });
    const answer = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(answer.text).toContain("didn't take the order");
    expect(answer.text).toContain("Nothing was ordered or paid");
    expect(store.payouts).toHaveLength(0);
    expect(rows[0]!.status).toBe("failed");
  });

  it("orders to pay on delivery when the supplier has no account in Munshi", async () => {
    store.suppliers = [];
    const { agent, book, approvalId } = await asked();
    const answer = await answerRestock({ store, book, supplier: agent, now: NOW }, approvalId, true);
    expect(answer.text).toContain("Pay on delivery");
    expect(answer.buttons).toBeUndefined();
    expect(store.payouts).toHaveLength(0);
  });
});

describe("the tap's id", () => {
  it("fits a Telegram button (callback data up to 64 bytes, ids up to 60)", () => {
    expect(`${RESTOCK_APPROVAL_PREFIX}${crypto.randomUUID()}`).toMatch(/^[A-Za-z0-9-]{1,60}$/);
  });
});

// The same loop against the real wholesaler agent over A2A: its signed quote is read and ordered
// as is. Off by default: RESTOCK_LIVE=1 (A2A_INTEROP_URL for a local agent; else the deployed one).
const liveUrl = process.env.RESTOCK_LIVE === "1" ? (process.env.A2A_INTEROP_URL ?? "https://munshi-wholesaler.vercel.app") : null;

describe.skipIf(!liveUrl)("with the live wholesaler agent", () => {
  it("asks with its signed quote, and haan places that order and makes the page", { timeout: 60_000 }, async () => {
    const supplier = createA2ASupplier(liveUrl!);
    const { book, rows } = memoryBook();
    const { chats, asks } = memoryChats();
    expect(await askToRestock({ store, book, chats, supplier, shopName: "RCB general stores" })).toBe("asked");
    console.log(asks[0]!.text);

    const answer = await answerRestock({ store, book, supplier }, asks[0]!.approvalId, true);
    console.log(answer.text);
    expect(answer.text).toMatch(/✅ Order ST-[0-9A-F]{8} placed with Sharma Traders/);
    expect(rows[0]!.status).toBe("executed");
    expect(store.payouts).toEqual([expect.objectContaining({ supplierId: "sup_1", amountPaise: store.supplierOrders[0]!.totalPaise })]);
    vi.restoreAllMocks();
  });
});
