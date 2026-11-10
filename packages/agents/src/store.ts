import type { Language, LedgerKind, Paise } from "@munshi/db";
import type { SupplierOrder } from "./supplier";

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
/** Something the owner asked Munshi to remember. customerId is null for a shop-wide fact. */
export type Memory = { id: string; fact: string; customerId: string | null; createdAt: string };

export interface KhataStore {
  listCustomers(): Promise<Customer[]>;
  addCustomer(input: { name: string; phone?: string; language?: Language; aliases?: string[] }): Promise<Customer>;
  addLedgerEntry(input: { kind: LedgerKind; amountPaise: Paise; customerId?: string; note?: string; traceId?: string }): Promise<LedgerEntry>;
  balances(customerId?: string): Promise<Balance[]>;
  recentEntries(limit: number, customerId?: string): Promise<LedgerEntry[]>;
  listProducts(): Promise<Product[]>;
  moveStock(input: { productId: string; delta: number; reason: string }): Promise<Product>;
  /** The stock level at or below which a product counts as running low; null removes the alert. */
  setReorderLevel(productId: string, level: number | null): Promise<Product>;
  /** Creates a Cashfree link and records it. Only called after the owner approved. */
  createPaymentLink(input: { customer: Customer; amountPaise: Paise; purpose: string }): Promise<PaymentLink>;
  /** Creates an exact-amount UPI QR for a customer at the counter. Throws if Cashfree can't issue one. */
  createPaymentQr(input: { customer: Customer; amountPaise: Paise; purpose: string }): Promise<PaymentQr>;
  /** Asks Cashfree about open links and QRs and records anything paid. */
  checkPayments(customerId?: string): Promise<PaymentCheck>;
  remember(input: { fact: string; customerId?: string }): Promise<Memory>;
  /** Facts about one customer, or shop-wide facts when customerId is null. */
  memories(customerId: string | null): Promise<Memory[]>;
  forget(memoryId: string): Promise<boolean>;
  audit(action: string, details: Record<string, unknown>): Promise<void>;
  /** Keeps a confirmed wholesaler order. Saving the same order twice keeps one. */
  saveSupplierOrder(order: SupplierOrder & { quoteId: string }): Promise<void>;
}
