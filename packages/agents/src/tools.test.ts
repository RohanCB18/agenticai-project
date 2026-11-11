import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GstPassage, KnowledgeBase } from "./knowledge";
import { MemoryStore } from "./testing/memory-store";
import { createKhataTools } from "./tools";

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
