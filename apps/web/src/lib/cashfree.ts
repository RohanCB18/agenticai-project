import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Cashfree Payment Links, API version 2026-01-01.
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create-payment-link

const API_VERSION = "2026-01-01";

export class CashfreeNotConfiguredError extends Error {
  constructor() {
    super("Cashfree is not configured. Add CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET (sandbox keys) to apps/web/.env.local.");
    this.name = "CashfreeNotConfiguredError";
  }
}

function config() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new CashfreeNotConfiguredError();
  const baseUrl = process.env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  return { clientId, clientSecret, baseUrl };
}

export type CreateLinkInput = {
  linkId: string;
  amountPaise: number;
  purpose: string;
  customer: { name: string; phone: string };
  expiresAt: Date;
  notifyUrl?: string;
  notes?: Record<string, string>;
};

export type CashfreeLink = {
  cf_link_id: string | number;
  link_id: string;
  link_url: string;
  link_status: string;
  link_amount: number;
  link_amount_paid: number;
  link_expiry_time: string;
};

/** Strips the country code: Cashfree expects a 10-digit Indian mobile number. */
function tenDigit(phone: string) {
  return phone.replace(/\D/g, "").slice(-10);
}

export async function createPaymentLink(input: CreateLinkInput): Promise<CashfreeLink> {
  const { clientId, clientSecret, baseUrl } = config();
  const res = await fetch(`${baseUrl}/links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-id": clientId,
      "x-client-secret": clientSecret,
      "x-api-version": API_VERSION,
      // Same key on retry means Cashfree won't create a duplicate link.
      "x-idempotency-key": input.linkId,
    },
    body: JSON.stringify({
      link_id: input.linkId,
      link_amount: input.amountPaise / 100,
      link_currency: "INR",
      link_purpose: input.purpose.slice(0, 500),
      customer_details: { customer_name: input.customer.name, customer_phone: tenDigit(input.customer.phone) },
      link_notify: { send_sms: true, send_email: false },
      link_expiry_time: input.expiresAt.toISOString(),
      link_meta: { upi_intent: "true", payment_methods: "upi", ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}) },
      link_notes: input.notes,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cashfree create link failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as CashfreeLink;
}

/**
 * Cashfree signs webhooks as base64(HMAC-SHA256(timestamp + rawBody, clientSecret)).
 * Must be checked against the raw body: re-serialised JSON turns "170.00" into 170 and breaks the signature.
 */
export function verifyWebhookSignature(rawBody: string, timestamp: string | null, signature: string | null, secret: string): boolean {
  if (!timestamp || !signature) return false;
  const expected = createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const LINK_STATUS = {
  ACTIVE: "active",
  PAID: "paid",
  PARTIALLY_PAID: "partially_paid",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
} as const;
