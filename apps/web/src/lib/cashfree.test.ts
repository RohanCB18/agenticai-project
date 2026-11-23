import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cashfreeName, getLink, parseCashfreeEvent, verifyWebhookSignature } from "./cashfree";

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
