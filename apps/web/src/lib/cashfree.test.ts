import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cashfreeName, createPaymentLink, createVendor, getLink, newVendorId, parseCashfreeEvent, verifyWebhookSignature } from "./cashfree";

describe("Cashfree calls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("gives every call a time limit, and says plainly when it ran out", async () => {
    vi.stubEnv("CASHFREE_CLIENT_ID", "id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "secret");
    const signals: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );
    await expect(getLink("munshi_1")).rejects.toThrow("didn't answer within 15 s");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("Easy Split (paying suppliers)", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const answer = (json: object) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json(json);
      }),
    );

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("makes a payment link whose whole amount Cashfree settles to the supplier's vendor account", async () => {
    vi.stubEnv("CASHFREE_CLIENT_ID", "id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "secret");
    answer({ cf_link_id: 1, link_id: "munshi_pay1", link_url: "https://payments-test.cashfree.com/links/x", link_status: "ACTIVE" });
    await createPaymentLink({
      linkId: "munshi_pay1",
      amountPaise: 10000,
      purpose: "Payment to Sharma Traders, through Munshi",
      customer: { name: "Rohan", phone: "+91 98765 43210" },
      expiresAt: new Date("2026-11-27T10:00:00Z"),
      splits: [{ vendorId: "munshiabc", amountPaise: 10000 }],
    });
    expect(calls[0]!.url).toBe("https://sandbox.cashfree.com/pg/links");
    expect(calls[0]!.body).toMatchObject({ link_amount: 100, order_splits: [{ vendor_id: "munshiabc", amount: 100 }] });
  });

  it("leaves customer links unsplit", async () => {
    vi.stubEnv("CASHFREE_CLIENT_ID", "id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "secret");
    answer({ cf_link_id: 2, link_id: "munshi_c1", link_url: "u", link_status: "ACTIVE" });
    await createPaymentLink({ linkId: "munshi_c1", amountPaise: 45000, purpose: "Udhaar", customer: { name: "Ramesh", phone: "9876543210" }, expiresAt: new Date() });
    expect(calls[0]!.body).not.toHaveProperty("order_splits");
  });

  it("adds a supplier as a B2B vendor, paid to their UPI ID or bank account", async () => {
    vi.stubEnv("CASHFREE_CLIENT_ID", "id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "secret");
    answer({ vendor_id: "munshiabc", status: "IN_BANK_VALIDATION" });
    const base = { vendorId: "munshiabc", name: "शर्मा ट्रेडर्स", email: "owner@example.com", phone: "+91 98765 43210" };
    expect(await createVendor({ ...base, account: { vpa: "sharma@okhdfc" }, kyc: { gst: "29ABCDE1234F1Z5" } })).toMatchObject({ status: "IN_BANK_VALIDATION" });
    await createVendor({ ...base, account: { bankAccount: "026291800001191", ifsc: "YESB0000262" }, kyc: { pan: "ABCDE1234F" } });

    expect(calls[0]!.url).toBe("https://sandbox.cashfree.com/pg/easy-split/vendors");
    const holder = calls[0]!.body.name as string;
    expect(holder).toMatch(/^[A-Za-z ]+$/); // Cashfree takes English letters
    expect(calls[0]!.body).toMatchObject({
      vendor_id: "munshiabc",
      status: "ACTIVE",
      phone: "9876543210",
      schedule_option: 1,
      upi: { vpa: "sharma@okhdfc", account_holder: holder },
      kyc_details: { account_type: "BUSINESS", business_type: "B2B", gst: "29ABCDE1234F1Z5" },
    });
    expect(calls[1]!.body).toMatchObject({
      bank: { account_number: "026291800001191", ifsc: "YESB0000262" },
      kyc_details: { pan: "ABCDE1234F" },
    });
  });

  it("gives vendors ids of letters and digits only, new for every set of details", () => {
    expect(newVendorId()).toMatch(/^munshi[0-9a-f]{32}$/);
    expect(newVendorId()).not.toBe(newVendorId());
  });
});

describe("cashfreeName", () => {
  it("gives Cashfree a name in English letters, whatever script the owner used", () => {
    // Live, Cashfree refused "ಸುರೇಶ್": "customer_details.customer_name : should be a person name".
    expect(cashfreeName("ಸುರೇಶ್")).toBe("Suresh");
    expect(cashfreeName("ರಮೇಶ್ ಕುಮಾರ್")).toBe("Ramesh Kumar");
    expect(cashfreeName("ಲಕ್ಷ್ಮಿ")).toBe("Lakshmi");
    expect(cashfreeName("Fatima")).toBe("Fatima");
    expect(cashfreeName("🙂")).toBe("Customer");
  });
});

describe("Cashfree events", () => {
  it("reads a paid link", () => {
    const raw = '{"type":"PAYMENT_LINK_EVENT","data":{"link_id":"munshi_abc","link_status":"PAID","link_amount_paid":"450.00"}}';
    expect(parseCashfreeEvent(raw)).toEqual({ kind: "link", linkId: "munshi_abc", status: "paid", paidPaise: 45000 });
  });

  it("reads a successful order payment in the documented format", () => {
    const raw =
      '{"data":{"order":{"order_id":"munshi_qr_1","order_amount":230},"payment":{"cf_payment_id":"1","payment_status":"SUCCESS","payment_amount":230}},"type":"PAYMENT_SUCCESS_WEBHOOK"}';
    expect(parseCashfreeEvent(raw)).toEqual({ kind: "order", orderId: "munshi_qr_1", paidPaise: 23000 });
  });

  it("ignores failed payments and other events", () => {
    expect(parseCashfreeEvent('{"type":"PAYMENT_FAILED_WEBHOOK","data":{"order":{"order_id":"x"},"payment":{"payment_status":"FAILED"}}}')).toBeNull();
    expect(parseCashfreeEvent('{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"x"},"payment":{"payment_status":"PENDING"}}}')).toBeNull();
    expect(parseCashfreeEvent('{"type":"REFUND_STATUS_WEBHOOK","data":{}}')).toBeNull();
  });
});

const secret = "test_secret";
// Raw body as Cashfree sends it. Note "450.00": re-serialising would turn it into 450.
const body = '{"type":"PAYMENT_LINK_EVENT","data":{"link_id":"munshi_abc","link_status":"PAID","link_amount_paid":"450.00"}}';
const timestamp = "1793630000000";
const sign = (payload: string) => createHmac("sha256", secret).update(timestamp + payload).digest("base64");

describe("Cashfree webhook signature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature(body, timestamp, sign(body), secret)).toBe(true);
  });

  it("rejects a tampered amount", () => {
    expect(verifyWebhookSignature(body.replace("450.00", "4500.00"), timestamp, sign(body), secret)).toBe(false);
  });

  it("rejects a re-serialised body", () => {
    const reserialised = JSON.stringify(JSON.parse(body.replace('"450.00"', "450.00")));
    expect(verifyWebhookSignature(reserialised, timestamp, sign(body), secret)).toBe(false);
  });

  it("rejects missing headers and the wrong secret", () => {
    expect(verifyWebhookSignature(body, null, sign(body), secret)).toBe(false);
    expect(verifyWebhookSignature(body, timestamp, sign(body), "other")).toBe(false);
  });
});
