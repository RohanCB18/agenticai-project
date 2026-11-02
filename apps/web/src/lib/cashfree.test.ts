import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./cashfree";

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
