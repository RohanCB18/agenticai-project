import { constants, createHmac, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransfer, maskedAccount, parsePayoutEvent, payoutSignature, payoutStatus, verifyPayoutWebhook } from "./cashfree-payouts";
import { payoutNotice } from "./supplier-payouts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Cashfree Payouts signature", () => {
  it("encrypts clientId.unixSeconds with the public key (RSA OAEP, SHA-1)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signature = payoutSignature("CF123", publicKey.export({ type: "spki", format: "pem" }).toString(), new Date("2026-11-17T10:00:00Z"));
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(signature, "base64")).toString();
    expect(plain).toBe(`CF123.${Date.parse("2026-11-17T10:00:00Z") / 1000}`);
  });

  it("signs every call when a public key is set, with a time limit", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("CASHFREE_PAYOUT_CLIENT_ID", "CF123");
    vi.stubEnv("CASHFREE_PAYOUT_CLIENT_SECRET", "secret");
    // As stored in an env var: one line, with the newlines escaped.
    vi.stubEnv("CASHFREE_PAYOUT_PUBLIC_KEY", publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "\\n"));
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ transfer_id: "munshi_1", status: "RECEIVED" });
      }),
    );

    await createTransfer({ transferId: "munshi_1", amountPaise: 420000, beneficiaryId: "munshi_b", mode: "upi", remarks: "Payment from Munshi!" });

    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe("https://sandbox.cashfree.com/payout/transfers");
    expect(headers.get("x-api-version")).toBe("2024-01-01");
    expect(headers.get("x-cf-signature")).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      transfer_id: "munshi_1",
      transfer_amount: 4200,
      transfer_currency: "INR",
      transfer_mode: "upi",
      beneficiary_details: { beneficiary_id: "munshi_b" },
      transfer_remarks: "Payment from Munshi ",
    });
  });
});

describe("Cashfree Payouts webhooks", () => {
  const body = (type: string, status: string, extra: object = {}) =>
    JSON.stringify({ type, event_time: "2026-11-17T10:00:00", data: { transfer_id: "munshi_1", cf_transfer_id: 12345, status, status_code: "COMPLETED", ...extra } });

  it("reads success, failure, reversal and rejection, and ignores the rest", () => {
    expect(parsePayoutEvent(body("TRANSFER_ACKNOWLEDGED", "SUCCESS", { transfer_utr: "UTR1" }))).toEqual({
      transferId: "munshi_1",
      cfTransferId: "12345",
      status: "success",
      statusCode: "COMPLETED",
      description: null,
      utr: "UTR1",
    });
    expect(parsePayoutEvent(body("TRANSFER_FAILED", "FAILED"))?.status).toBe("failed");
    expect(parsePayoutEvent(body("TRANSFER_REJECTED", "REJECTED"))?.status).toBe("failed");
    expect(parsePayoutEvent(body("TRANSFER_REVERSED", "REVERSED"))?.status).toBe("reversed");
    expect(parsePayoutEvent(JSON.stringify({ type: "LOW_BALANCE_ALERT", data: {} }))).toBeNull();
    expect(payoutStatus("RECEIVED")).toBe("pending");
  });

  it("checks the signature with the Payouts client secret", () => {
    vi.stubEnv("CASHFREE_PAYOUT_CLIENT_SECRET", "payout-secret");
    const raw = body("TRANSFER_SUCCESS", "SUCCESS");
    const signature = createHmac("sha256", "payout-secret").update(`1731830400${raw}`).digest("base64");
    expect(verifyPayoutWebhook(raw, "1731830400", signature)).toBe(true);
    expect(verifyPayoutWebhook(raw.replace("munshi_1", "munshi_2"), "1731830400", signature)).toBe(false);
    vi.stubEnv("CASHFREE_PAYOUT_CLIENT_SECRET", "");
    expect(verifyPayoutWebhook(raw, "1731830400", signature)).toBe(false);
  });
});

describe("what the owner sees", () => {
  it("masks where the money goes", () => {
    expect(maskedAccount({ payout_vpa: "sharmatraders@okhdfc", payout_account_last4: null })).toBe("UPI sh•••@okhdfc");
    expect(maskedAccount({ payout_vpa: null, payout_account_last4: "1191" })).toBe("bank ••••1191");
  });

  it("says when a payout landed, failed or came back, and nothing while on its way", () => {
    const base = { supplier_name: "Sharma Traders", amount_paise: 420000 };
    expect(payoutNotice({ ...base, status: "success" }, { utr: "UTR1", description: null })).toBe("✅ Paid Sharma Traders ₹4,200. UTR UTR1.");
    expect(payoutNotice({ ...base, status: "failed" }, { utr: null, description: "Invalid account" })).toContain("failed (Invalid account). The money stays");
    expect(payoutNotice({ ...base, status: "reversed" }, { utr: null, description: null })).toContain("sent back");
    expect(payoutNotice({ ...base, status: "pending" }, { utr: null, description: null })).toBeNull();
  });
});
