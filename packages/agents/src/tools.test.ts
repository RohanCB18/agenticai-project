import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GstPassage, KnowledgeBase } from "./knowledge";
import { receiptLines } from "./receipts";
import type { Product } from "./store";
import { MemoryStore } from "./testing/memory-store";
import { createKhataTools, paymentLinkApproval } from "./tools";

// Tools are called directly here; the agent loop itself is covered in khata-agent.test.ts.
const ctx = { toolCallId: "t1", messages: [], context: {} } as never;

let store: MemoryStore;
let tools: ReturnType<typeof createKhataTools>;

beforeEach(async () => {
  store = new MemoryStore();
  await store.addCustomer({ name: "Ramesh", phone: "+919800000001", aliases: ["ರಮೇಶ್"] });
  await store.addCustomer({ name: "Ramesh Kumar" });
  await store.addCustomer({ name: "Fatima" });
  tools = createKhataTools(store);
});

describe("khata tools", () => {
  it("records udhaar in paise and reports the new balance", async () => {
    const out = await tools.recordCredit.execute!({ customerName: "ರಮೇಶ್", amount: 450.5 }, ctx);
    expect(out).toMatchObject({ status: "recorded", customer: "Ramesh", nowOwes: "₹450.5" });
    expect(store.entries[0]?.amountPaise).toBe(45050);
  });

  it("asks instead of guessing between similar names", async () => {
    const out = await tools.recordCredit.execute!({ customerName: "Ramesh K", amount: 100 }, ctx);
    expect(out).toMatchObject({ status: "ambiguous_customer" });
    expect(store.entries).toHaveLength(0);
  });

  it("refuses to record against unknown customers", async () => {
    const out = await tools.recordPayment.execute!({ customerName: "Suresh", amount: 100, method: "cash" }, ctx);
    expect(out).toMatchObject({ status: "customer_not_found" });
  });

  it("checks the ledger for a repeat instead of recording twice", async () => {
    await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "cash" }, ctx);
    const again = (await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "cash" }, ctx)) as Record<string, unknown>;
    expect(again).toMatchObject({ status: "possible_repeat", customer: "Fatima", amount: "₹200", savedMinutesAgo: 0 });
    expect(store.entries).toHaveLength(1);
    // The model saying "it's new" on its own changes nothing: in testing it did, and saved twice.
    expect(await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "cash", confirmedNew: true }, ctx)).toMatchObject({ status: "possible_repeat" });
    // After Munshi asked and the owner said it's a new one, it is saved.
    const asked = {
      ...(ctx as object),
      messages: [
        { role: "tool", content: [{ type: "tool-result", toolCallId: "t0", toolName: "recordPayment", output: { type: "json", value: again } }] },
        { role: "assistant", content: "Fatima ka 200 abhi likha tha. Naya hai?" },
        { role: "user", content: "Haan, naya hai" },
      ],
    } as never;
    expect(await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "cash", confirmedNew: true }, asked)).toMatchObject({ status: "recorded" });
    // A different amount, or udhaar rather than a payment, isn't a repeat.
    expect(await tools.recordPayment.execute!({ customerName: "Fatima", amount: 150, method: "cash" }, ctx)).toMatchObject({ status: "recorded" });
    expect(await tools.recordCredit.execute!({ customerName: "Fatima", amount: 200 }, ctx)).toMatchObject({ status: "recorded" });
    expect(store.entries).toHaveLength(4);
  });

  it("records the same amount again once the repeat window has passed", async () => {
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 300 }, ctx);
    store.entries[0]!.createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
    expect(await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 300 }, ctx)).toMatchObject({ status: "recorded" });
  });

  it("calls money paid beyond the udhaar an advance, never a negative balance", async () => {
    const out = await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "cash" }, ctx);
    expect(out).toMatchObject({ status: "recorded", nowOwes: "₹0", advance: "₹200" });
    expect(await tools.getBalances.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ total: "₹0", customers: [{ name: "Fatima", owes: "₹0", advance: "₹200" }] });
  });

  it("nets payments against credit", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 1200 }, ctx);
    const out = await tools.recordPayment.execute!({ customerName: "Fatima", amount: 200, method: "upi" }, ctx);
    expect(out).toMatchObject({ nowOwes: "₹1,000" });
  });

  it("never requests more than the customer owes", async () => {
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 300 }, ctx);
    const out = await tools.sendPaymentLink.execute!({ customerName: "Ramesh", amount: 500 }, ctx);
    expect(out).toMatchObject({ status: "exceeds_balance" });
    expect(store.links).toHaveLength(0);
  });

  it("defaults the payment link to the full balance", async () => {
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 430 }, ctx);
    const out = await tools.sendPaymentLink.execute!({ customerName: "Ramesh" }, ctx);
    expect(out).toMatchObject({ status: "sent", amount: "₹430" });
    expect(store.links[0]?.amountPaise).toBe(43000);
  });

  it("needs a phone number before sending a link", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 100 }, ctx);
    const out = await tools.sendPaymentLink.execute!({ customerName: "Fatima" }, ctx);
    expect(out).toMatchObject({ status: "missing_phone" });
  });

  it("says a link wasn't sent when the payment service fails", async () => {
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 430 }, ctx);
    store.linkFails = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await tools.sendPaymentLink.execute!({ customerName: "Ramesh" }, ctx);
    quiet.mockRestore();
    expect(out).toMatchObject({ status: "link_failed", customer: "Ramesh", hint: expect.stringContaining("NOT created") });
    expect(store.links).toHaveLength(0);
  });

  it("tells the agent when the customer wasn't notified of a link", async () => {
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 430 }, ctx);
    const out = await tools.sendPaymentLink.execute!({ customerName: "Ramesh" }, ctx);
    expect(out).toMatchObject({ customerNotified: false });
  });
});

describe("in-shop QR", () => {
  it("defaults to the full balance and needs no phone number", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 230 }, ctx);
    const out = await tools.showPaymentQr.execute!({ customerName: "Fatima" }, ctx);
    expect(out).toMatchObject({ status: "qr_ready", customer: "Fatima", amount: "₹230", validForMinutes: 20 });
    expect(store.qrs[0]?.amountPaise).toBe(23000);
    expect(store.auditLog.at(-1)?.action).toBe("payment_qr_shown");
  });

  it("never shows a QR for more than the customer owes", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 100 }, ctx);
    const out = await tools.showPaymentQr.execute!({ customerName: "Fatima", amount: 500 }, ctx);
    expect(out).toMatchObject({ status: "exceeds_balance" });
    expect(store.qrs).toHaveLength(0);
  });

  it("offers a way out when Cashfree can't issue a QR", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 100 }, ctx);
    store.qrFails = true;
    const out = await tools.showPaymentQr.execute!({ customerName: "Fatima" }, ctx);
    expect(out).toMatchObject({ status: "qr_unavailable" });
  });
});

describe("checkPayment", () => {
  it("reports a received payment with the new balance", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 500 }, ctx);
    store.nextCheck = { paidPaise: 20000, stillOpen: 0 };
    const out = await tools.checkPayment.execute!({ customerName: "Fatima" }, ctx);
    expect(out).toMatchObject({ status: "payment_received", customer: "Fatima", received: "₹200", nowOwes: "₹500" });
  });

  it("says so when nothing new arrived, with or without a name", async () => {
    store.nextCheck = { paidPaise: 0, stillOpen: 2 };
    const out = await tools.checkPayment.execute!({}, ctx);
    expect(out).toMatchObject({ status: "no_new_payment", stillWaitingOn: 2 });
  });
});

describe("memory", () => {
  it("remembers a fact about a customer once, even if said twice", async () => {
    const first = await tools.remember.execute!({ fact: "Ramesh is Lakshmi's husband", customerName: "ರಮೇಶ್" }, ctx);
    expect(first).toMatchObject({ status: "remembered", about: "Ramesh" });
    const again = await tools.remember.execute!({ fact: "ramesh is lakshmi's husband ", customerName: "Ramesh" }, ctx);
    expect(again).toMatchObject({ status: "already_known" });
    expect(store.facts).toHaveLength(1);
  });

  it("keeps shop facts apart from customer facts", async () => {
    await tools.remember.execute!({ fact: "Call the owner Akka" }, ctx);
    await tools.remember.execute!({ fact: "Pays by GPay", customerName: "Fatima" }, ctx);
    expect(await tools.recall.execute!({}, ctx)).toMatchObject({ about: "the shop", facts: [{ fact: "Call the owner Akka" }] });
    expect(await tools.recall.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ about: "Fatima", facts: [{ fact: "Pays by GPay" }] });
  });

  it("forgets by id", async () => {
    await tools.remember.execute!({ fact: "Closed on Sundays" }, ctx);
    const id = store.facts[0]!.id;
    expect(await tools.forget.execute!({ memoryId: id }, ctx)).toEqual({ status: "forgotten" });
    expect(await tools.forget.execute!({ memoryId: id }, ctx)).toEqual({ status: "not_found" });
  });

  it("won't describe payment habits without enough history", async () => {
    await tools.recordPayment.execute!({ customerName: "Fatima", amount: 100, method: "upi" }, ctx);
    expect(await tools.paymentHabits.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ status: "not_enough_history", payments: 1 });
  });
});

describe("updateCustomer", () => {
  it("adds a phone number, after which a payment link can go out", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 300 }, ctx);
    expect(await tools.sendPaymentLink.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ status: "missing_phone", hint: expect.stringContaining("updateCustomer") });
    const out = await tools.updateCustomer.execute!({ customerName: "Fatima", phone: "98000 00002" }, ctx);
    expect(out).toEqual({ status: "updated", customer: "Fatima", phone: "9800000002" });
    expect(await tools.sendPaymentLink.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ status: "sent", amount: "₹300" });
    expect(store.auditLog.at(-2)).toMatchObject({ action: "customer_updated", details: { phoneChanged: true } });
  });

  it("says which number it replaced", async () => {
    const out = await tools.updateCustomer.execute!({ customerName: "ರಮೇಶ್", phone: "+919800000009" }, ctx);
    expect(out).toMatchObject({ customer: "Ramesh", phone: "+919800000009", previousPhone: "+919800000001" });
  });

  it("keeps the old name as an alias after a rename", async () => {
    const out = await tools.updateCustomer.execute!({ customerName: "Fatima", newName: "Fatima Begum" }, ctx);
    expect(out).toMatchObject({ status: "updated", customer: "Fatima Begum", previousName: "Fatima" });
    expect(store.customers.find((c) => c.name === "Fatima Begum")?.aliases).toContain("Fatima");
    expect(await tools.getBalances.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ customers: [{ name: "Fatima Begum" }] });
  });

  it("asks rather than guessing who, or what to change", async () => {
    expect(await tools.updateCustomer.execute!({ customerName: "Ramesh K", phone: "9800000003" }, ctx)).toMatchObject({ status: "ambiguous_customer" });
    expect(await tools.updateCustomer.execute!({ customerName: "Fatima" }, ctx)).toMatchObject({ status: "nothing_to_change" });
    expect(store.customers.find((c) => c.name === "Fatima")?.phone).toBeNull();
  });
});

describe("customerHistory", () => {
  it("lists what a customer took and paid in the window, newest first, with totals", async () => {
    const fatima = store.customers.find((c) => c.name === "Fatima")!;
    await store.addPastEntry({ kind: "credit_given", amountPaise: 50000, customerId: fatima.id, note: "rice and dal" }, 40);
    await store.addPastEntry({ kind: "credit_given", amountPaise: 12000, customerId: fatima.id, note: "Maggi" }, 20);
    await store.addPastEntry({ kind: "payment_received", amountPaise: 30000, customerId: fatima.id, note: "upi" }, 5);
    await store.addPastEntry({ kind: "credit_given", amountPaise: 9900, customerId: store.customers[0]!.id }, 3); // someone else

    const out = (await tools.customerHistory.execute!({ customerName: "Fatima", days: 30 }, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ status: "history", customer: "Fatima", days: 30, tookOnCredit: "₹120", paid: "₹300", nowOwes: "₹320" });
    expect(out.entries).toEqual([
      { date: expect.any(String), type: "payment", amount: "₹300", note: "upi" },
      { date: expect.any(String), type: "udhaar", amount: "₹120", note: "Maggi" },
    ]);
    // A year back includes the rice and dal.
    expect(await tools.customerHistory.execute!({ customerName: "Fatima", days: 365 }, ctx)).toMatchObject({ tookOnCredit: "₹620" });
  });

  it("dates entries in India time", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T12:00:00Z"), toFake: ["Date"] });
    try {
      const entry = await store.addLedgerEntry({ kind: "credit_given", amountPaise: 1000, customerId: store.customers[2]!.id });
      entry.createdAt = "2026-11-09T20:00:00Z"; // 1:30 am on the 10th in India
      const out = (await tools.customerHistory.execute!({ customerName: "Fatima", days: 7 }, ctx)) as { entries: { date: string }[] };
      expect(out.entries[0]?.date).toBe("10 Nov 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says when there is nothing in the window", async () => {
    expect(await tools.customerHistory.execute!({ customerName: "Fatima", days: 7 }, ctx)).toMatchObject({ entries: [], hint: expect.stringContaining("Nothing") });
  });
});

describe("lookupGst", () => {
  const notification9 = {
    id: "ctr-09-2025",
    title: "Notification No. 9/2025-Central Tax (Rate)",
    gsr: "G.S.R. 641(E)",
    dated: "2025-09-17",
    effectiveFrom: "2025-09-22",
    url: "https://example.test/09_2025-CTR.pdf",
  };
  const noodles: GstPassage = {
    id: "ctr-09-2025:I:119",
    kind: "rate",
    hsn: "1902",
    description: "Seviyan (vermicelli); Pasta ... noodles",
    gst: 5,
    content: "Seviyan (vermicelli); Pasta ... noodles. HSN 1902. GST 5% (CGST 2.5% + SGST 2.5%, or IGST 5% between states). Schedule I, S. No. 119 of Notification No. 9/2025-Central Tax (Rate), in force from 22 September 2025.",
    sources: [notification9],
  };
  const looseAtta: GstPassage = {
    id: "ctr-10-2025:70",
    kind: "exempt",
    hsn: "1101",
    description: "Wheat or meslin flour, other than pre-packaged and labelled",
    gst: 0,
    content: "Wheat or meslin flour, other than pre-packaged and labelled. HSN 1101. Exempt from GST (nil rate). S. No. 70 of Notification No. 10/2025-Central Tax (Rate), in force from 22 September 2025.",
    sources: [{ ...notification9, id: "ctr-10-2025", title: "Notification No. 10/2025-Central Tax (Rate)" }],
  };
  const knowledge = (passages: GstPassage[]): KnowledgeBase => ({ searchGst: vi.fn(async () => passages) });

  it("answers with the total GST and the entry to cite", async () => {
    const kb = knowledge([noodles, looseAtta]);
    const out = await createKhataTools(store, "Sri Ganesh Stores", { knowledge: kb }).lookupGst.execute!({ item: "instant noodles" }, ctx);
    expect(kb.searchGst).toHaveBeenCalledWith("instant noodles", 5);
    expect(out).toMatchObject({
      status: "found",
      entries: [
        {
          hsn: "1902",
          gst: "5%",
          citation: "Schedule I, S. No. 119 of Notification No. 9/2025-Central Tax (Rate)",
          sources: [{ notification: "Notification No. 9/2025-Central Tax (Rate)", inForceFrom: "2025-09-22", url: "https://example.test/09_2025-CTR.pdf" }],
        },
        { gst: "0% (exempt)", citation: "S. No. 70 of Notification No. 10/2025-Central Tax (Rate)" },
      ],
      hint: expect.stringContaining("only from these entries"),
    });
  });

  it("says so when nothing matches, the lookup fails, or it isn't set up", async () => {
    expect(await createKhataTools(store, "S", { knowledge: knowledge([]) }).lookupGst.execute!({ item: "spaceship" }, ctx)).toMatchObject({ status: "not_found" });
    const broken: KnowledgeBase = { searchGst: async () => Promise.reject(new Error("db down")) };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createKhataTools(store, "S", { knowledge: broken }).lookupGst.execute!({ item: "rice" }, ctx)).toMatchObject({ status: "knowledge_unavailable" });
    quiet.mockRestore();
    expect(await tools.lookupGst.execute!({ item: "rice" }, ctx)).toMatchObject({ status: "no_knowledge" });
  });
});

describe("setProductGst", () => {
  const source = { id: "ctr-09-2025", title: "Notification No. 9/2025-Central Tax (Rate)", gsr: "G.S.R. 641(E)", dated: "2025-09-17", effectiveFrom: "2025-09-22", url: "https://example.test/9.pdf" };
  const entry = (id: string, hsn: string, gst: number, sno: string, description: string): GstPassage => ({
    id,
    kind: gst === 0 ? "exempt" : "rate",
    hsn,
    description,
    gst,
    content: `${description}. HSN ${hsn}. Schedule I, S. No. ${sno} of Notification No. 9/2025-Central Tax (Rate).`,
    sources: [source],
  });
  const noodles = entry("r:119", "1902", 5, "119", "Pasta, noodles");
  const looseRice = entry("e:rice", "1006", 0, "60", "Rice, other than pre-packaged and labelled");
  const packedRice = entry("r:rice", "1006", 5, "61", "Rice, pre-packaged and labelled");
  const horses = entry("r:1", "0101 21 00", 5, "1", "Live horses"); // a search can return unrelated entries
  const kb = (passages: GstPassage[]): KnowledgeBase => ({ searchGst: vi.fn(async () => [...passages, horses]) });

  beforeEach(() => {
    store.products.push(
      { id: "p1", name: "Maggi", aliases: [], unit: "pkt", stockQty: 40, reorderLevel: null, pricePaise: null },
      { id: "p2", name: "Sona Masoori Rice", aliases: ["akki"], unit: "kg", stockQty: 25, reorderLevel: null, pricePaise: null },
    );
  });

  it("tags a product with the one official rate for its code, and the entry it comes from", async () => {
    const knowledge = kb([noodles]);
    const out = await createKhataTools(store, "S", { knowledge }).setProductGst.execute!({ productName: "maggi", hsn: "1902" }, ctx);
    expect(knowledge.searchGst).toHaveBeenCalledWith("1902 Maggi", 10);
    expect(out).toEqual({ status: "tagged", product: "Maggi", hsn: "1902", gst: "5%", citation: "Schedule I, S. No. 119 of Notification No. 9/2025-Central Tax (Rate)" });
    expect(store.products[0]).toMatchObject({ hsn: "1902", gstRate: 5, gstCitation: "Schedule I, S. No. 119 of Notification No. 9/2025-Central Tax (Rate)" });
  });

  it("lists the official rates when the goods decide, and saves only the one the owner chose", async () => {
    const tool = createKhataTools(store, "S", { knowledge: kb([looseRice, packedRice]) }).setProductGst;
    const ask = (await tool.execute!({ productName: "akki", hsn: "1006 30" }, ctx)) as { status: string; options: { gst: string }[] };
    expect(ask.status).toBe("choose_rate");
    expect(ask.options.map((o) => o.gst)).toEqual(["5%", "0%"]);
    expect(store.products[1]?.hsn).toBeUndefined();

    expect(await tool.execute!({ productName: "akki", hsn: "1006 30", gstRate: 18 }, ctx)).toMatchObject({ status: "rate_not_official" });
    expect(store.products[1]?.hsn).toBeUndefined();

    // The entries list 1006, so that is the code kept: a finer one would be the agent's guess.
    expect(await tool.execute!({ productName: "akki", hsn: "1006 30", gstRate: 5 }, ctx)).toMatchObject({ status: "tagged", hsn: "1006", gst: "5%" });
    expect(store.products[1]).toMatchObject({ hsn: "1006", gstRate: 5 });
  });

  it("saves nothing for a code no entry covers, an unknown product, or without the knowledge base", async () => {
    const tools = createKhataTools(store, "S", { knowledge: kb([noodles]) });
    expect(await tools.setProductGst.execute!({ productName: "Maggi", hsn: "9999" }, ctx)).toMatchObject({ status: "not_found" });
    expect(await tools.setProductGst.execute!({ productName: "Spaceship", hsn: "1902" }, ctx)).toMatchObject({ status: "product_not_found" });
    expect(await createKhataTools(store).setProductGst.execute!({ productName: "Maggi", hsn: "1902" }, ctx)).toMatchObject({ status: "no_knowledge" });
    expect(store.products[0]?.hsn).toBeUndefined();
  });

  it("shows each product's tag in getStock", async () => {
    await createKhataTools(store, "S", { knowledge: kb([noodles]) }).setProductGst.execute!({ productName: "Maggi", hsn: "1902" }, ctx);
    const out = (await tools.getStock.execute!({ lowOnly: false }, ctx)) as { products: { name: string; gst: unknown }[] };
    expect(out.products.map((p) => [p.name, p.gst])).toEqual([
      ["Maggi", { hsn: "1902", rate: "5%" }],
      ["Sona Masoori Rice", "not tagged"],
    ]);
  });
});

describe("tagAllProducts", () => {
  const source = { id: "ctr-09-2025", title: "Notification No. 9/2025-Central Tax (Rate)", gsr: "G.S.R. 641(E)", dated: "2025-09-17", effectiveFrom: "2025-09-22", url: "https://example.test/9.pdf" };
  const entry = (id: string, hsn: string, gst: number, sno: string, description: string): GstPassage => ({
    id,
    kind: gst === 0 ? "exempt" : "rate",
    hsn,
    description,
    gst,
    content: `${description}. HSN ${hsn}. Schedule I, S. No. ${sno} of Notification No. 9/2025-Central Tax (Rate).`,
    sources: [source],
  });
  const sugar = entry("r:105", "1701", 5, "105", "Cane or beet sugar and chemically pure sucrose, in solid form");
  const jaggery = entry("e:jaggery", "1701", 0, "94", "Jaggery of all types including Cane Jaggery (gur), other than pre-packaged and labelled");
  const packedDal = entry("r:20", "0713", 5, "20", "Dried leguminous vegetables, shelled, whether or not skinned or split, pre-packaged and labelled");
  const looseDal = entry("e:39", "0713", 0, "39", "Dried leguminous vegetables, shelled, whether or not skinned or split, other than pre-packaged and labelled");
  const biscuits = entry("r:123", "1905", 5, "123", "Pastry, cakes, biscuits and other bakers' wares");
  const roti = entry("e:roti", "1905", 0, "100", "Khakhra, plain chapatti or roti");
  // A search by what the goods are, as the real one does: the code in the query brings its entries.
  const knowledge: KnowledgeBase = {
    searchGst: vi.fn(async (query: string) => {
      if (/sugar/i.test(query)) return [sugar, jaggery];
      if (/pulses/i.test(query)) return [packedDal, looseDal];
      if (/biscuit/i.test(query)) return [biscuits, roti];
      return [];
    }),
  };
  const product = (id: string, name: string, extra: Partial<Product> = {}): Product => ({ id, name, aliases: [], unit: "kg", stockQty: 10, reorderLevel: null, pricePaise: null, ...extra });
  let bulk: ReturnType<typeof createKhataTools>["tagAllProducts"];

  beforeEach(() => {
    store.products.push(
      product("p1", "Sugar"),
      product("p2", "Toor dal"),
      product("p3", "Parle G", { unit: "box" }),
      product("p4", "Rice", { hsn: "1006", gstRate: 5, gstCitation: "S. No. 48" }),
      product("p5", "Sunflower oil", { unit: "ltr" }),
    );
    bulk = createKhataTools(store, "S", { knowledge }).tagAllProducts;
  });

  it("lists the untagged products first, and tags nothing", async () => {
    expect(await bulk.execute!({ products: [] }, ctx)).toMatchObject({ status: "untagged_products", products: ["Sugar", "Toor dal", "Parle G", "Sunflower oil"] });
    expect(store.products.filter((p) => p.hsn)).toHaveLength(1);
  });

  it("tags what the official entries confirm, asks loose or packed, and refuses a code the goods don't carry", async () => {
    const out = (await bulk.execute!(
      {
        products: [
          { productName: "sugar", hsn: "1701", goods: "sugar" }, // jaggery shares 1701 at 0%, but isn't sugar
          { productName: "toor dal", hsn: "0713", goods: "pulses, split" },
          { productName: "Parle G", hsn: "1704", goods: "biscuits" }, // wrong code: biscuits are 1905
          { productName: "Rice", hsn: "1006", goods: "rice" },
          { productName: "Spaceship", hsn: "8802", goods: "spaceship" },
        ],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(out).toMatchObject({
      status: "tagged",
      tagged: [{ product: "Sugar", hsn: "1701", gst: "5%", citation: "Schedule I, S. No. 105 of Notification No. 9/2025-Central Tax (Rate)" }],
      chooseRate: [{ product: "Toor dal", hsn: "0713", options: [{ gst: "5%", gstRate: 5 }, { gst: "0%", gstRate: 0 }] }],
      unconfirmed: [{ product: "Parle G", hsn: "1704", officialFor: [{ hsn: "1905" }, { hsn: "1905" }] }],
      alreadyTagged: ["Rice"],
      notFound: ["Spaceship"],
      notInYourList: ["Sunflower oil"],
    });
    expect(store.products.find((p) => p.name === "Sugar")).toMatchObject({ hsn: "1701", gstRate: 5 });
    for (const name of ["Toor dal", "Parle G", "Sunflower oil"]) expect(store.products.find((p) => p.name === name)?.hsn).toBeUndefined();
    expect(receiptLines([{ tool: "tagAllProducts", output: out }])).toEqual(["🧾 GST tag: Sugar · HSN 1701 · 5%"]);
  });

  it("keeps a single rate when a different good shares the code", async () => {
    const out = await bulk.execute!({ products: [{ productName: "Parle G", hsn: "1905", goods: "biscuits" }] }, ctx);
    expect(out).toMatchObject({ status: "tagged", tagged: [{ product: "Parle G", gst: "5%" }], chooseRate: [] });
  });

  it("finishes products a bill gave a code but no rate", async () => {
    // Live: after a bill, sugar and Parle-G had HSN codes and "rate to choose", and tag-all skipped them.
    store.products.find((p) => p.name === "Sugar")!.hsn = "1701";
    store.products.find((p) => p.name === "Parle G")!.hsn = "1905";
    const listed = (await bulk.execute!({ products: [] }, ctx)) as Record<string, unknown>;
    expect(listed).toMatchObject({ status: "untagged_products", codeButNoRate: [{ product: "Sugar", hsn: "1701" }, { product: "Parle G", hsn: "1905" }] });
    expect(listed.products).toEqual(["Sugar", "Toor dal", "Parle G", "Sunflower oil"]);

    const out = await bulk.execute!(
      { products: [{ productName: "Sugar", hsn: "1701", goods: "sugar" }, { productName: "Parle G", hsn: "1905", goods: "biscuits" }] },
      ctx,
    );
    expect(out).toMatchObject({ status: "tagged", tagged: [{ product: "Sugar", gst: "5%" }, { product: "Parle G", gst: "5%" }] });
    expect(store.products.find((p) => p.name === "Sugar")).toMatchObject({ hsn: "1701", gstRate: 5 });
  });

  it("says a shop with no products has nothing to tag", async () => {
    // Live, a new shop was told "every product is tagged".
    store.products.length = 0;
    expect(await bulk.execute!({ products: [] }, ctx)).toMatchObject({ status: "no_products", hint: expect.stringContaining("no products") });
  });

  it("says when everything is tagged, or the lookup is down", async () => {
    for (const p of store.products) Object.assign(p, { hsn: p.hsn ?? "1006", gstRate: p.gstRate ?? 5 });
    expect(await bulk.execute!({ products: [] }, ctx)).toMatchObject({ status: "all_tagged" });

    for (const p of store.products) p.hsn = undefined;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = createKhataTools(store, "S", { knowledge: { searchGst: async () => Promise.reject(new Error("503")) } }).tagAllProducts;
    expect(await down.execute!({ products: [{ productName: "Sugar", hsn: "1701", goods: "sugar" }] }, ctx)).toMatchObject({ status: "knowledge_unavailable" });
    quiet.mockRestore();
    expect(store.products.every((p) => !p.hsn)).toBe(true);
  });
});

describe("paying suppliers", () => {
  const order = (orderId: string, totalPaise: number) => ({
    supplier: "Sharma Traders",
    orderId,
    quoteId: `q_${orderId}`,
    lines: [],
    total: `₹${totalPaise / 100}`,
    totalPaise,
    deliverySlot: "Tomorrow 9-11 am",
    payment: "Pay on delivery",
  });

  beforeEach(() => {
    store.suppliers = [{ id: "sup_1", name: "Sharma Traders", aliases: [], account: "UPI su•••@upi", verified: true }];
    store.supplierOrders = [order("ST-1", 420000), order("ST-2", 150000)];
  });

  it("shows what is due and where it would go", async () => {
    const out = await tools.supplierDues.execute!({ supplierName: "sharma traders" }, ctx);
    expect(out).toMatchObject({ status: "dues", supplier: "Sharma Traders", payTo: "UPI su•••@upi", totalDue: "₹5,700" });
    expect(out).toMatchObject({ hint: expect.stringContaining("whether to pay ₹5,700") });
  });

  it("asks about the amount the owner named, not the whole due", async () => {
    // Live, "Sharma Traders ko 100 rupaye payment kar do" got "poora 3,900 payment karun?".
    const out = await tools.supplierDues.execute!({ supplierName: "Sharma Traders", amount: 100 }, ctx);
    expect(out).toMatchObject({ status: "dues", totalDue: "₹5,700", ownerAsked: "₹100" });
    expect(out).toMatchObject({ hint: expect.stringContaining("one yes-or-no question about paying ₹100, never a different amount") });
    expect(await tools.supplierDues.execute!({ supplierName: "Sharma Traders", amount: 9000 }, ctx)).toMatchObject({
      hint: expect.stringContaining("more than the ₹5,700 due"),
    });
  });

  it("reads the owner's amount from their message when the model leaves it out", async () => {
    // Live again on 26 Nov: the model called supplierDues without the ₹100, and asked about ₹3,900.
    const said = { toolCallId: "t2", messages: [{ role: "user", content: "Sharma Traders ko 100 rupaye payment kar do" }], context: {} } as never;
    expect(await tools.supplierDues.execute!({ supplierName: "Sharma Traders" }, said)).toMatchObject({ ownerAsked: "₹100" });
    // No amount said: the whole due.
    const none = { toolCallId: "t3", messages: [{ role: "user", content: "Sharma Traders ko payment kar do" }], context: {} } as never;
    const out = await tools.supplierDues.execute!({ supplierName: "Sharma Traders" }, none);
    expect(out).not.toHaveProperty("ownerAsked");
    expect(out).toMatchObject({ hint: expect.stringContaining("whether to pay ₹5,700") });
  });

  it("makes a Cashfree payment page for a verified supplier, and stops showing the order as due", async () => {
    const out = await tools.paySupplier.execute!({ supplierName: "Sharma", amount: 4200 }, ctx);
    expect(out).toMatchObject({
      status: "pay_link",
      supplier: "Sharma Traders",
      amount: "₹4,200",
      to: "UPI su•••@upi",
      forOrder: "ST-1",
      url: "https://payments-test.cashfree.com/links/sup_1",
      hint: expect.stringContaining("never say it is paid"),
    });
    expect(receiptLines([{ tool: "paySupplier", output: out as Record<string, unknown> }])).toEqual([
      "💸 Payment page for Sharma Traders ₹4,200 · pay it and Cashfree sends it to UPI su•••@upi",
    ]);
    expect(store.payouts).toEqual([expect.objectContaining({ supplierId: "sup_1", amountPaise: 420000, supplierOrderId: "ST-1" })]);
    expect(await tools.supplierDues.execute!({ supplierName: "Sharma Traders" }, ctx)).toMatchObject({ totalDue: "₹1,500" });
  });

  it("reports a payment Cashfree finished at once, and one it refused", async () => {
    store.payoutStatus = "success";
    expect(await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 1500 }, ctx)).toMatchObject({ status: "paid", utr: "UTR123" });
    store.payoutStatus = "failed";
    expect(await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 4200 }, ctx)).toMatchObject({ status: "payout_failed", reason: "Invalid beneficiary account" });
  });

  it("says a payment from the balance has started, and never that it arrived", async () => {
    store.payoutVia = "balance";
    const out = await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 4200 }, ctx);
    expect(out).toMatchObject({ status: "payout_started", hint: expect.stringContaining("Never say it has reached them") });
    expect(out).not.toHaveProperty("url");
    expect(receiptLines([{ tool: "paySupplier", output: out as Record<string, unknown> }])).toEqual([
      "💸 Paying Sharma Traders ₹4,200 to UPI su•••@upi from your Cashfree balance · started, Munshi will confirm",
    ]);
  });

  it("falls back to a page to pay, and says why the balance didn't", async () => {
    store.balanceFailed = "not enough money in your Cashfree Payouts balance";
    expect(await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 4200 }, ctx)).toMatchObject({
      status: "pay_link",
      balanceFailed: "not enough money in your Cashfree Payouts balance",
      hint: expect.stringContaining("Paying from the Cashfree balance didn't work (not enough money in your Cashfree Payouts balance), so instead a Cashfree payment page"),
    });
  });

  it("never pays an account the owner hasn't confirmed, or a supplier it doesn't know", async () => {
    store.suppliers[0]!.verified = false;
    expect(await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 4200 }, ctx)).toMatchObject({
      status: "no_payout_account",
      hint: expect.stringContaining("dashboard"),
    });
    expect(await tools.paySupplier.execute!({ supplierName: "Gupta Wholesale", amount: 100 }, ctx)).toMatchObject({ status: "no_payout_account" });
    expect(await tools.supplierDues.execute!({ supplierName: "Sharma Traders" }, ctx)).toMatchObject({ status: "no_payout_account", totalDue: "₹5,700" });
    expect(store.payouts).toHaveLength(0);
  });

  it("says nothing was paid when the payment service fails", async () => {
    store.payoutFails = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await tools.paySupplier.execute!({ supplierName: "Sharma Traders", amount: 4200 }, ctx);
    quiet.mockRestore();
    expect(out).toMatchObject({ status: "payout_failed", hint: expect.stringContaining("NOT made") });
  });
});

describe("makeChart", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const code = 'import pandas as pd\nd = pd.read_csv("daily.csv")\nd.plot(x="date", y=["cash_sales", "udhaar"], stacked=True)';
  const chart = (input: { title: string; about: "sales" | "cash_sales" | "udhaar" | "other"; code?: string }, t = tools) =>
    t.makeChart.execute!({ period: "last_7_days", code, ...input }, ctx);

  it("runs the program over the shop's data, keeps the picture and counts the totals itself", async () => {
    await tools.recordSale.execute!({ kind: "sale", amount: 1200 }, ctx);
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 450 }, ctx);
    const runs: { code: string; files: Record<string, string> }[] = [];
    const charted = createKhataTools(store, "S", { charts: { run: async (input) => (runs.push(input), { ok: true, png, stdout: "Highest day Rs 1650" }) } });

    const out = await chart({ title: "Sales this week", about: "sales" }, charted);

    expect(out).toMatchObject({
      status: "chart_ready",
      chartId: store.charts[0]!.id,
      title: "Sales this week",
      entries: 2,
      totals: { sales: "₹1,650", cashSales: "₹1,200", udhaar: "₹450" },
      summary: "Highest day Rs 1650",
    });
    expect(runs[0]!.code).toBe(code);
    expect(runs[0]!.files["ledger.csv"]).toContain(",sale,1200,,");
    expect(runs[0]!.files["daily.csv"]).toContain(",1200,450,1650,");
    expect(store.charts[0]!.png).toEqual(png);
  });

  it("hands back a program's error for the agent to fix, and says when the sandbox is down", async () => {
    await tools.recordSale.execute!({ kind: "sale", amount: 500 }, ctx);
    const failing = createKhataTools(store, "S", { charts: { run: async () => ({ ok: false, error: "KeyError: 'amt'" }) } });
    expect(await chart({ title: "Sales", about: "sales" }, failing)).toMatchObject({ status: "chart_error", error: "KeyError: 'amt'" });

    const down = createKhataTools(store, "S", { charts: { run: async () => Promise.reject(new Error("sandbox timeout")) } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await chart({ title: "Sales", about: "sales" }, down)).toMatchObject({ status: "chart_unavailable" });
    quiet.mockRestore();
    expect(store.charts).toHaveLength(0);
  });

  it("sends a sales program that leaves out udhaar back to be fixed, without running it", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 450 }, ctx);
    let ran = false;
    const charted = createKhataTools(store, "S", { charts: { run: async () => ((ran = true), { ok: true, png, stdout: "" }) } });
    const cashOnly = 'import pandas as pd\ndf = pd.read_csv("ledger.csv")\nsales = df[df.type == "sale"]';
    expect(await chart({ title: "Sales", about: "sales", code: cashOnly }, charted)).toMatchObject({ status: "chart_error", error: expect.stringContaining("udhaar") });
    expect(ran).toBe(false);
  });

  it("sends no empty picture when there is nothing to draw", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 450 }, ctx);
    let ran = false;
    const charted = createKhataTools(store, "S", { charts: { run: async () => ((ran = true), { ok: true, png, stdout: "" }) } });
    // Counted by the app: a week of udhaar and no cash sale.
    expect(await chart({ title: "Cash sales", about: "cash_sales" }, charted)).toMatchObject({ status: "nothing_to_chart", summary: expect.stringMatching(/^no cash sales \(/) });
    expect(ran).toBe(false);

    // Or said by the program, for a question only it can answer.
    const empty = createKhataTools(store, "S", {
      charts: { run: async () => ({ ok: false, error: "The program ran but didn't save chart.png.", stdout: "NOTHING_TO_CHART: no udhaar above Rs 1000" }) },
    });
    expect(await chart({ title: "Big udhaar", about: "udhaar" }, empty)).toMatchObject({ status: "nothing_to_chart", summary: "no udhaar above Rs 1000" });
    expect(store.charts).toHaveLength(0);
  });

  it("says when charts are off or the khata is empty", async () => {
    expect(await chart({ title: "Sales", about: "sales" })).toMatchObject({ status: "charts_off" });
    const charted = createKhataTools(store, "S", { charts: { run: async () => ({ ok: true, png, stdout: "" }) } });
    expect(await chart({ title: "Anything", about: "other" }, charted)).toMatchObject({ status: "nothing_to_chart", summary: expect.stringContaining("no entries") });
  });
});

describe("checkGstPortal", () => {
  it("starts a background lookup and says the answer will follow", async () => {
    const started: string[] = [];
    const portaled = createKhataTools(store, "S", { portal: { start: async (q) => void started.push(q) } });
    expect(await portaled.checkGstPortal.execute!({ question: "What is the HSN code for makhana?" }, ctx)).toMatchObject({ status: "checking_portal" });
    expect(started).toEqual(["What is the HSN code for makhana?"]);
  });

  it("says when browsing is off or can't start", async () => {
    expect(await tools.checkGstPortal.execute!({ question: "HSN for makhana?" }, ctx)).toMatchObject({ status: "browsing_off" });
    const broken = createKhataTools(store, "S", { portal: { start: async () => Promise.reject(new Error("queue down")) } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await broken.checkGstPortal.execute!({ question: "HSN for makhana?" }, ctx)).toMatchObject({ status: "portal_unavailable" });
    quiet.mockRestore();
  });

  it("says where the answer would go when the shop has no chat app linked", async () => {
    const webOnly = createKhataTools(store, "S", { portal: { start: async () => "no_inbox" as const } });
    expect(await webOnly.checkGstPortal.execute!({ question: "HSN for makhana?" }, ctx)).toMatchObject({ status: "no_inbox", hint: expect.stringContaining("Connect Telegram") });
  });
});

describe("paymentLinkApproval", () => {
  it("puts the amount the link will ask for on the owner's button", async () => {
    // Live, the button said "their full balance", so the owner approved without seeing ₹650.
    await tools.recordCredit.execute!({ customerName: "Ramesh", amount: 650 }, ctx);
    expect(await paymentLinkApproval(store, { customerName: "Ramesh" })).toEqual({ type: "user-approval", reason: "₹650 (full balance)" });
    expect(await paymentLinkApproval(store, { customerName: "Ramesh", amount: 200 })).toEqual({ type: "user-approval", reason: "₹200" });
  });

  it("still asks, with nothing to show, when the tool will refuse", async () => {
    expect(await paymentLinkApproval(store, { customerName: "Spaceship" })).toEqual({ type: "user-approval" });
    expect(await paymentLinkApproval(store, { customerName: "Fatima" })).toEqual({ type: "user-approval" }); // owes nothing
  });
});

describe("addProduct", () => {
  it("adds goods the shop didn't have, with the stock that arrived, after updateStock found nothing", async () => {
    // Live, in a new shop, "20 packet Maggi aaye" could only end in "is its name something else?".
    expect(await tools.updateStock.execute!({ productName: "Maggi", change: 20, reason: "purchase" }, ctx)).toMatchObject({
      status: "product_not_found",
      hint: expect.stringContaining("addProduct"),
    });
    const out = await tools.addProduct.execute!({ name: "Maggi", unit: "pkt", stock: 20 }, ctx);
    expect(out).toEqual({ status: "added", product: "Maggi", stock: "20 pkt" });
    expect(receiptLines([{ tool: "addProduct", output: out as Record<string, unknown> }])).toEqual(["🧾 New product: Maggi · 20 pkt"]);
    expect(await tools.updateStock.execute!({ productName: "maggi", change: -2, reason: "sale" }, ctx)).toMatchObject({ status: "updated", stock: "18 pkt" });
  });

  it("never adds a product twice", async () => {
    await tools.addProduct.execute!({ name: "Toor dal", unit: "kg" }, ctx);
    expect(await tools.addProduct.execute!({ name: "toor dal", unit: "kg", stock: 5 }, ctx)).toMatchObject({ status: "already_exists", product: "Toor dal", stock: "0 kg" });
    expect(store.products).toHaveLength(1);
  });
});

describe("correctEntry", () => {
  it("changes a wrong amount instead of adding a second entry", async () => {
    // Live, "bijli ka bill 800 nahi 600 tha, theek kar do" recorded another ₹600: expenses ₹1,400.
    await tools.recordSale.execute!({ kind: "expense", amount: 800, note: "bijli" }, ctx);
    const out = await tools.correctEntry.execute!({ kind: "expense", wrongAmount: 800, rightAmount: 600 }, ctx);
    expect(out).toMatchObject({ status: "corrected", entry: "Expense", was: "₹800", now: "₹600" });
    expect(store.entries.map((e) => [e.kind, e.amountPaise])).toEqual([["expense", 60000]]);
    expect(store.auditLog.at(-1)).toMatchObject({ action: "ledger_entry_corrected", details: { was: 80000, now: 60000 } });
    expect(receiptLines([{ tool: "correctEntry", output: out as Record<string, unknown> }])[0]).toMatch(/^🧾 Fixed: Expense ₹800 → ₹600 \(/);
  });

  it("removes a customer's entry and gives the new balance", async () => {
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 450 }, ctx);
    await tools.recordCredit.execute!({ customerName: "Fatima", amount: 300 }, ctx);
    const out = await tools.correctEntry.execute!({ kind: "udhaar", customerName: "Fatima", rightAmount: 0 }, ctx);
    expect(out).toMatchObject({ status: "removed", entry: "Udhaar Fatima", was: "₹300", nowOwes: "₹450" });
    expect(receiptLines([{ tool: "correctEntry", output: out as Record<string, unknown> }])[0]).toMatch(/^🧾 Removed: Udhaar Fatima ₹300 \(.+\) · owes ₹450$/);
  });

  it("changes nothing it can't find, and never what Cashfree recorded", async () => {
    expect(await tools.correctEntry.execute!({ kind: "sale", wrongAmount: 999, rightAmount: 500 }, ctx)).toMatchObject({ status: "entry_not_found" });
    expect(await tools.correctEntry.execute!({ kind: "payment", rightAmount: 100 }, ctx)).toMatchObject({ status: "need_customer" });

    const paidOnline = await store.addLedgerEntry({ kind: "payment_received", amountPaise: 25000, customerId: store.customers[2]!.id });
    paidOnline.source = "webhook";
    expect(await tools.correctEntry.execute!({ kind: "payment", customerName: "Fatima", rightAmount: 100 }, ctx)).toMatchObject({ status: "not_editable" });
    expect(paidOnline.amountPaise).toBe(25000);
  });
});
