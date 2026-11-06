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
    expect(out).toMatchObject({ status: "qr_ready", customer: "Fatima", amount: "₹230" });
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
