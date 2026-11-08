import { beforeEach, describe, expect, it } from "vitest";
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
