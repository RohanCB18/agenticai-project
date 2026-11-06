import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseCashfreeEvent, verifyWebhookSignature } from "./cashfree";

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
