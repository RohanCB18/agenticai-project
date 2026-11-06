import type { Language, LedgerKind, Paise } from "@munshi/db";

// The khata agent talks to storage only through this interface, so it can run
// against Supabase in the app and an in-memory fake in tests.

export type Customer = { id: string; name: string; aliases: string[]; phone: string | null; language: Language | null };
export type Product = { id: string; name: string; aliases: string[]; unit: string; stockQty: number; reorderLevel: number | null; pricePaise: number | null };
export type Balance = { customerId: string; name: string; outstandingPaise: Paise; lastCreditAt: string | null; lastPaymentAt: string | null };
export type LedgerEntry = { id: string; kind: LedgerKind; amountPaise: Paise; customerId: string | null; note: string | null; createdAt: string };

export type PaymentLink = {
  id: string;
  url: string;
  amountPaise: Paise;
  status: string;
  expiresAt: string | null;
  /** True only if the customer was actually told (Cashfree sends SMS in production, not sandbox). */
  customerNotified: boolean;
};
export type PaymentQr = { id: string; amountPaise: Paise; expiresAt: string };
export type PaymentCheck = { paidPaise: Paise; stillOpen: number };

export interface KhataStore {
  listCustomers(): Promise<Customer[]>;
  addCustomer(input: { name: string; phone?: string; language?: Language; aliases?: string[] }): Promise<Customer>;
  addLedgerEntry(input: { kind: LedgerKind; amountPaise: Paise; customerId?: string; note?: string; traceId?: string }): Promise<LedgerEntry>;
  balances(customerId?: string): Promise<Balance[]>;
  recentEntries(limit: number, customerId?: string): Promise<LedgerEntry[]>;
  listProducts(): Promise<Product[]>;
  moveStock(input: { productId: string; delta: number; reason: string }): Promise<Product>;
  /** Creates a Cashfree link and records it. Only called after the owner approved. */
  createPaymentLink(input: { customer: Customer; amountPaise: Paise; purpose: string }): Promise<PaymentLink>;
  /** Creates an exact-amount UPI QR for a customer at the counter. Throws if Cashfree can't issue one. */
  createPaymentQr(input: { customer: Customer; amountPaise: Paise; purpose: string }): Promise<PaymentQr>;
  /** Asks Cashfree about open links and QRs and records anything paid. */
  checkPayments(customerId?: string): Promise<PaymentCheck>;
  audit(action: string, details: Record<string, unknown>): Promise<void>;
}
