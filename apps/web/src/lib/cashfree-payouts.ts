import "server-only";
import { constants, publicEncrypt } from "node:crypto";
import { verifyWebhookSignature } from "@/lib/cashfree";

// Cashfree Payouts, API v2 (x-api-version 2024-01-01): paying suppliers from the shop's Cashfree
// balance. A separate Cashfree product from Payment Links, with its own keys.
// Docs: https://www.cashfree.com/docs/api-reference/payouts/v2/payouts-api-v2-new

const API_VERSION = "2024-01-01";
/** Like Payment Links: a stalled call fails in time for the owner to be told. */
export const PAYOUT_TIMEOUT_MS = 15_000;

export class PayoutsNotConfiguredError extends Error {
  constructor() {
    super("Cashfree Payouts is not configured. Add CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET (Payouts sandbox keys).");
    this.name = "PayoutsNotConfiguredError";
  }
}

export const payoutsConfigured = () => Boolean(process.env.CASHFREE_PAYOUT_CLIENT_ID && process.env.CASHFREE_PAYOUT_CLIENT_SECRET);

function config() {
  const clientId = process.env.CASHFREE_PAYOUT_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new PayoutsNotConfiguredError();
  const baseUrl = process.env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout";
  // Env vars hold the PEM with "\n" escaped.
  const publicKey = process.env.CASHFREE_PAYOUT_PUBLIC_KEY?.replace(/\\n/g, "\n");
  return { clientId, clientSecret, baseUrl, publicKey };
}

/**
 * Cashfree's two-factor check for servers without a fixed IP (Vercel): the client id and the
 * current Unix time, "clientId.timestamp", encrypted with the account's Payouts public key (RSA,
 * OAEP padding with SHA-1) and base64-encoded. Valid for 5 minutes, so made fresh for every call.
 */
export function payoutSignature(clientId: string, publicKeyPem: string, now = new Date()) {
  const message = `${clientId}.${Math.floor(now.getTime() / 1000)}`;
  return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(message)).toString("base64");
}

async function request<T>(what: string, path: string, init: RequestInit = {}): Promise<T> {
  const { clientId, clientSecret, baseUrl, publicKey } = config();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-client-id": clientId,
    "x-client-secret": clientSecret,
    "x-api-version": API_VERSION,
    ...(publicKey ? { "x-cf-signature": payoutSignature(clientId, publicKey) } : {}),
  };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(PAYOUT_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Cashfree Payouts ${what} didn't answer within ${PAYOUT_TIMEOUT_MS / 1000} s`);
    throw error;
  }
  if (!res.ok) throw new Error(`Cashfree Payouts ${what} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export type PayoutAccount = { vpa: string } | { bankAccount: string; ifsc: string };

export type Beneficiary = { beneficiary_id: string; beneficiary_status?: string };

/** Registers a supplier's UPI ID or bank account with Cashfree, which checks it. */
export function createBeneficiary(input: { beneficiaryId: string; name: string; account: PayoutAccount; phone?: string | null }) {
  const instrument = "vpa" in input.account ? { vpa: input.account.vpa } : { bank_account_number: input.account.bankAccount, bank_ifsc: input.account.ifsc };
  const phone = input.phone?.replace(/\D/g, "").slice(-10);
  return request<Beneficiary>("add beneficiary", "/beneficiary", {
    method: "POST",
    body: JSON.stringify({
      beneficiary_id: input.beneficiaryId,
      // Cashfree accepts letters and spaces only.
      beneficiary_name: input.name.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Supplier",
      beneficiary_instrument_details: instrument,
      ...(phone?.length === 10 ? { beneficiary_contact_details: { beneficiary_phone: phone, beneficiary_country_code: "+91" } } : {}),
    }),
  });
}

export type Transfer = {
  transfer_id: string;
  cf_transfer_id?: string | number;
  status: string;
  status_code?: string;
  status_description?: string;
  transfer_utr?: string;
};

/** Starts a transfer to a saved beneficiary. Cashfree finishes it later and reports by webhook. */
export function createTransfer(input: { transferId: string; amountPaise: number; beneficiaryId: string; mode: "upi" | "banktransfer"; remarks: string }) {
  return request<Transfer>("transfer", "/transfers", {
    method: "POST",
    body: JSON.stringify({
      transfer_id: input.transferId,
      transfer_amount: input.amountPaise / 100,
      transfer_currency: "INR",
      transfer_mode: input.mode,
      beneficiary_details: { beneficiary_id: input.beneficiaryId },
      transfer_remarks: input.remarks.replace(/[^A-Za-z0-9 ]/g, " ").slice(0, 70),
    }),
  });
}

export function getTransfer(transferId: string) {
  return request<Transfer>("transfer status", `/transfers?transfer_id=${encodeURIComponent(transferId)}`);
}

export type PayoutStatus = "pending" | "success" | "failed" | "reversed";

/**
 * Munshi's status for a Cashfree transfer status. SUCCESS counts once the money has left for the
 * supplier's bank (SENT_TO_BENEFICIARY or COMPLETED); a bank that returns it later is REVERSED.
 * REJECTED and FAILED both mean nothing was paid.
 */
export function payoutStatus(status: string | undefined): PayoutStatus {
  switch (status) {
    case "SUCCESS":
      return "success";
    case "FAILED":
    case "REJECTED":
    case "MANUALLY_REJECTED":
      return "failed";
    case "REVERSED":
      return "reversed";
    default:
      return "pending";
  }
}

export type PayoutEvent = { transferId: string; cfTransferId: string | null; status: PayoutStatus; statusCode: string | null; description: string | null; utr: string | null };

/** What Cashfree says about one transfer (its answer to a status check, or a webhook's data). */
export function transferEvent(transfer: Transfer): PayoutEvent {
  return {
    transferId: transfer.transfer_id,
    cfTransferId: transfer.cf_transfer_id === undefined ? null : String(transfer.cf_transfer_id),
    status: payoutStatus(transfer.status),
    statusCode: transfer.status_code ?? null,
    description: transfer.status_description ?? null,
    utr: transfer.transfer_utr || null,
  };
}

/** A transfer webhook (TRANSFER_SUCCESS, _ACKNOWLEDGED, _FAILED, _REVERSED, _REJECTED), or null. */
export function parsePayoutEvent(raw: string): PayoutEvent | null {
  const event = JSON.parse(raw) as { type?: string; data?: Transfer };
  if (!event.type?.startsWith("TRANSFER_") || !event.data?.transfer_id) return null;
  return transferEvent(event.data);
}

/** Payouts webhooks are signed like Payment Links ones, with the Payouts client secret. */
export function verifyPayoutWebhook(rawBody: string, timestamp: string | null, signature: string | null) {
  const secret = process.env.CASHFREE_PAYOUT_CLIENT_SECRET;
  return Boolean(secret) && verifyWebhookSignature(rawBody, timestamp, signature, secret!);
}

export type PayoutDelivery = { kind: "ignore" } | { kind: "reject" } | { kind: "event"; event: PayoutEvent };

/**
 * What to do with one webhook delivery. Only a transfer update changes the books, so only it must
 * carry a valid header signature; everything else is acknowledged and ignored. Cashfree's own
 * "Test & Add Webhook" sends a LOW_BALANCE_ALERT with its signature in the body, not the headers:
 * checking every delivery first refused it with 401 and the webhook couldn't be added.
 */
export function payoutDelivery(rawBody: string, timestamp: string | null, signature: string | null): PayoutDelivery {
  let event: PayoutEvent | null;
  try {
    event = parsePayoutEvent(rawBody);
  } catch {
    return { kind: "ignore" }; // not JSON: nothing Munshi can act on
  }
  if (!event) return { kind: "ignore" };
  return verifyPayoutWebhook(rawBody, timestamp, signature) ? { kind: "event", event } : { kind: "reject" };
}

/** "UPI su•••@upi" or "bank ••••1191": where the money goes, without showing all of it. */
export function maskedAccount(supplier: { payout_vpa: string | null; payout_account_last4: string | null }) {
  if (supplier.payout_vpa) {
    const [user = "", host = ""] = supplier.payout_vpa.split("@");
    return `UPI ${user.slice(0, 2)}•••@${host}`;
  }
  return supplier.payout_account_last4 ? `bank ••••${supplier.payout_account_last4}` : null;
}
