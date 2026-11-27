import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { romanise } from "@munshi/agents";

// Cashfree Payment Links, API version 2026-01-01.
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create-payment-link

const API_VERSION = "2026-01-01";

/**
 * A customer's name as Cashfree takes it: a person's name in English letters. It refuses
 * "ಸುರೇಶ್" ("should be a person name"), so a customer the owner saved in Kannada, Hindi or Tamil
 * script could never be sent a link. Munshi keeps the owner's spelling; Cashfree gets "Suresh".
 */
export function cashfreeName(name: string) {
  // Long vowels come out doubled ("kumaar", "phaatimaa"); a customer reads the name on the page.
  const latin = romanise(name).replace(/[^A-Za-z .'-]/g, " ").replace(/([aiu])\1/g, "$1").replace(/\s+/g, " ").trim();
  return latin ? latin.replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase()) : "Customer";
}

export class CashfreeNotConfiguredError extends Error {
  constructor() {
    super("Cashfree is not configured. Add CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET (sandbox keys) to apps/web/.env.local.");
    this.name = "CashfreeNotConfiguredError";
  }
}

const isProduction = () => process.env.CASHFREE_ENV === "production";

function config() {
  const clientId = process.env.CASHFREE_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new CashfreeNotConfiguredError();
  const baseUrl = isProduction() ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  const headers = { "content-type": "application/json", "x-client-id": clientId, "x-client-secret": clientSecret, "x-api-version": API_VERSION };
  return { baseUrl, headers };
}

/** Cashfree only delivers link SMS in production; in sandbox the customer hears nothing. */
export const cashfreeSendsSms = isProduction;

/**
 * How long one Cashfree call may take. Live, a turn after a payment-link approval hung until Vercel
 * stopped the function at 60 s and the owner heard nothing: a stalled call must fail in time for
 * Munshi to say so.
 */
export const CASHFREE_TIMEOUT_MS = 15_000;

async function request<T>(what: string, path: string, init: RequestInit = {}): Promise<T> {
  const { baseUrl, headers } = config();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(CASHFREE_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error(`Cashfree ${what} didn't answer within ${CASHFREE_TIMEOUT_MS / 1000} s`);
    throw error;
  }
  if (!res.ok) throw new Error(`Cashfree ${what} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

export type CreateLinkInput = {
  linkId: string;
  amountPaise: number;
  purpose: string;
  customer: { name: string; phone: string };
  expiresAt: Date;
  notifyUrl?: string;
  notes?: Record<string, string>;
  /** Easy Split: the part of the payment Cashfree settles to a vendor (a supplier) instead of the shop. */
  splits?: { vendorId: string; amountPaise: number }[];
  /** Whether Cashfree texts the customer the link (production only). Off for a page shown at the counter. */
  sendSms?: boolean;
  /** Where Cashfree sends the customer after they pay (an online order's status page). */
  returnUrl?: string;
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

export function createPaymentLink(input: CreateLinkInput): Promise<CashfreeLink> {
  return request<CashfreeLink>("create link", "/links", {
    method: "POST",
    // Same key on retry means Cashfree won't create a duplicate link.
    headers: { "x-idempotency-key": input.linkId },
    body: JSON.stringify({
      link_id: input.linkId,
      link_amount: input.amountPaise / 100,
      link_currency: "INR",
      link_purpose: input.purpose.slice(0, 500),
      customer_details: { customer_name: cashfreeName(input.customer.name), customer_phone: tenDigit(input.customer.phone) },
      link_notify: { send_sms: (input.sendSms ?? true) && cashfreeSendsSms(), send_email: false },
      link_expiry_time: input.expiresAt.toISOString(),
      // Customers go straight to UPI (the app on a phone, a QR on a computer). In the sandbox, that
      // QR is one no real app can pay, so a tester also gets net banking, whose test bank can approve
      // a payment; UPI intent stays off there, since it skips the list of methods.
      link_meta: {
        upi_intent: isProduction(),
        payment_methods: isProduction() ? "upi" : "upi,nb",
        ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
        ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      },
      link_notes: input.notes,
      ...(input.splits?.length ? { order_splits: input.splits.map((s) => ({ vendor_id: s.vendorId, amount: s.amountPaise / 100 })) } : {}),
    }),
  });
}

// Easy Split vendors: how Munshi pays suppliers. The owner pays a Cashfree payment link split to the
// supplier, and Cashfree settles that amount to the supplier's UPI ID or bank account. Cashfree
// Payouts (paying out of a balance kept with Cashfree) did this before, until its test account
// began rejecting every transfer with ERROR_SELECTING_FUND_SOURCE.
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/easy-split/create-vendor

export type PayoutAccount = { vpa: string } | { bankAccount: string; ifsc: string };

export type VendorInput = {
  vendorId: string;
  name: string;
  email: string;
  phone: string;
  account: PayoutAccount;
  /** Cashfree needs a vendor's GSTIN or PAN. */
  kyc: { gst: string } | { pan: string };
};

export type Vendor = { vendor_id: string; status: string };

/** A new vendor id for each set of details, so an old id never points somewhere new. Letters and digits only. */
export const newVendorId = () => `munshi${crypto.randomUUID().replaceAll("-", "")}`;

/**
 * Registers a supplier as an Easy Split vendor, settled the day after each payment (schedule 1).
 * Cashfree then checks the account (IN_BANK_VALIDATION, then ACTIVE); a link split to the vendor
 * can be made straight away.
 */
export function createVendor(input: VendorInput): Promise<Vendor> {
  const holder = cashfreeName(input.name);
  return request<Vendor>("add vendor", "/easy-split/vendors", {
    method: "POST",
    body: JSON.stringify({
      vendor_id: input.vendorId,
      status: "ACTIVE",
      name: holder,
      email: input.email,
      phone: tenDigit(input.phone),
      verify_account: false,
      dashboard_access: false,
      schedule_option: 1,
      ...("vpa" in input.account
        ? { upi: { vpa: input.account.vpa, account_holder: holder } }
        : { bank: { account_number: input.account.bankAccount, account_holder: holder, ifsc: input.account.ifsc } }),
      // A wholesaler supplying shops: Cashfree's "B2B" business type.
      kyc_details: { account_type: "BUSINESS", business_type: "B2B", ...input.kyc },
    }),
  });
}

export function getVendor(vendorId: string): Promise<Vendor> {
  return request<Vendor>("get vendor", `/easy-split/vendors/${encodeURIComponent(vendorId)}`);
}

/** Vendor states that can't be paid. IN_BANK_VALIDATION and ACTIVE can. */
export const VENDOR_UNUSABLE = ["BLOCKED", "DELETED", "BANK_VALIDATION_FAILED", "INACTIVE"];

export type CreateQrInput = {
  orderId: string;
  amountPaise: number;
  customer: { id: string; name: string; phone: string | null };
  expiresAt: Date;
  notifyUrl?: string;
  note: string;
};

/**
 * An exact-amount UPI QR: creates an order, then asks Order Pay for a QR. Returns the PNG as
 * base64. Order Pay works in sandbox, but in production Cashfree only enables it (the "S2S"
 * flag) for accounts showing over Rs 1 crore annual turnover, so callers must handle failure.
 */
export async function createUpiQr(input: CreateQrInput): Promise<{ qrPng: string }> {
  const order = await request<{ payment_session_id: string }>("create order", "/orders", {
    method: "POST",
    headers: { "x-idempotency-key": input.orderId },
    body: JSON.stringify({
      order_id: input.orderId,
      order_amount: input.amountPaise / 100,
      order_currency: "INR",
      customer_details: {
        customer_id: input.customer.id,
        customer_name: cashfreeName(input.customer.name),
        // Orders require a phone; a walk-in customer may not have one on file.
        customer_phone: input.customer.phone ? tenDigit(input.customer.phone) : "9999999999",
      },
      order_expiry_time: input.expiresAt.toISOString(),
      order_note: input.note.slice(0, 200),
      ...(input.notifyUrl ? { order_meta: { notify_url: input.notifyUrl } } : {}),
    }),
  });

  const payment = await request<{ data?: { payload?: { qrcode?: string } } }>("create QR", "/orders/sessions", {
    method: "POST",
    // NPCI needs the customer's device details; the customer scans with their own phone, so these are generic.
    headers: { "x-client-device": "desktop", "x-client-os": "others", "x-client-browser": "others" },
    body: JSON.stringify({ payment_session_id: order.payment_session_id, payment_method: { upi: { channel: "qrcode" } } }),
  });
  const qrcode = payment.data?.payload?.qrcode;
  if (!qrcode) throw new Error("Cashfree returned no QR code");
  return { qrPng: qrcode.replace(/^data:image\/png;base64,/, "") };
}

/** Live status, for checking a payment without waiting for a webhook. */
export function getOrder(orderId: string) {
  return request<{ order_status: string; order_amount: number }>("get order", `/orders/${encodeURIComponent(orderId)}`);
}

export function getLink(linkId: string) {
  return request<{ link_status: keyof typeof LINK_STATUS; link_amount_paid: number }>("get link", `/links/${encodeURIComponent(linkId)}`);
}

/**
 * Total paid on a link according to its orders, in paise. Cashfree warns that link_status can
 * stay EXPIRED after a successful payment, so a link's own status can't be trusted alone.
 */
export async function paidOnLinkOrders(linkId: string) {
  const orders = await request<{ order_status: string; order_amount: number }[]>("get link orders", `/links/${encodeURIComponent(linkId)}/orders`);
  return orders.filter((order) => order.order_status === "PAID").reduce((sum, order) => sum + Math.round(order.order_amount * 100), 0);
}

/** Fails with link_not_active if the link was already paid, cancelled or expired. */
export function cancelLink(linkId: string) {
  return request("cancel link", `/links/${encodeURIComponent(linkId)}/cancel`, { method: "POST" });
}

/** Ending an order is asynchronous: Cashfree answers TERMINATION_REQUESTED, then TERMINATED. */
export function terminateOrder(orderId: string) {
  return request("end order", `/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: JSON.stringify({ order_status: "TERMINATED" }) });
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

export type LinkStatus = (typeof LINK_STATUS)[keyof typeof LINK_STATUS];

export type CashfreeEvent =
  | { kind: "link"; linkId: string; status: LinkStatus; paidPaise: number }
  | { kind: "order"; orderId: string; paidPaise: number };

/** Reads the two webhooks Munshi uses (payment links, order payments); null for anything else. */
export function parseCashfreeEvent(raw: string): CashfreeEvent | null {
  const event = JSON.parse(raw) as {
    type?: string;
    data?: {
      link_id?: string;
      link_status?: keyof typeof LINK_STATUS;
      link_amount_paid?: string | number;
      order?: { order_id?: string };
      payment?: { payment_status?: string; payment_amount?: string | number };
    };
  };
  const toPaise = (rupees: string | number | undefined) => Math.round(Number(rupees ?? 0) * 100);

  if (event.type === "PAYMENT_LINK_EVENT" && event.data?.link_id && event.data.link_status && LINK_STATUS[event.data.link_status]) {
    return { kind: "link", linkId: event.data.link_id, status: LINK_STATUS[event.data.link_status], paidPaise: toPaise(event.data.link_amount_paid) };
  }
  if (event.type === "PAYMENT_SUCCESS_WEBHOOK" && event.data?.order?.order_id && event.data.payment?.payment_status === "SUCCESS") {
    return { kind: "order", orderId: event.data.order.order_id, paidPaise: toPaise(event.data.payment.payment_amount) };
  }
  return null;
}
