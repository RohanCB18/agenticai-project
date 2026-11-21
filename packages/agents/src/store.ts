import type { Language, LedgerKind, Paise } from "@munshi/db";
import type { SupplierOrder } from "./supplier";

// The khata agent talks to storage only through this interface, so it can run
// against Supabase in the app and an in-memory fake in tests.

export type Customer = { id: string; name: string; aliases: string[]; phone: string | null; language: Language | null };
export type Product = {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  stockQty: number;
  reorderLevel: number | null;
  pricePaise: number | null;
  /** HSN code, digits only, and the official GST rate with the entry it comes from. Null until tagged. */
  hsn?: string | null;
  gstRate?: number | null;
  gstCitation?: string | null;
};
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

/**
 * A supplier the shop pays. `account` is where money would go ("UPI su•••@upi"), set only by the
 * owner in the dashboard; `verified` means the owner confirmed it with the supplier. The agent can
 * pay only a verified account, and can never add or change one.
 */
export type Supplier = { id: string; name: string; aliases: string[]; account: string | null; verified: boolean };
/** A wholesaler order not yet paid (nor being paid). */
export type SupplierOrderDue = { id: string; orderRef: string; totalPaise: Paise; createdAt: string };
export type SupplierPayout = { id: string; status: "pending" | "success" | "failed" | "reversed"; amountPaise: Paise; utr: string | null; reason: string | null };

export interface KhataStore {
  listCustomers(): Promise<Customer[]>;
  addCustomer(input: { name: string; phone?: string; language?: Language; aliases?: string[] }): Promise<Customer>;
  /** Changes a customer's name, aliases or phone; fields left out stay as they are. */
  updateCustomer(customerId: string, changes: { name?: string; aliases?: string[]; phone?: string }): Promise<Customer>;
  addLedgerEntry(input: { kind: LedgerKind; amountPaise: Paise; customerId?: string; note?: string; traceId?: string }): Promise<LedgerEntry>;
  balances(customerId?: string): Promise<Balance[]>;
  recentEntries(limit: number, customerId?: string): Promise<LedgerEntry[]>;
  listProducts(): Promise<Product[]>;
  moveStock(input: { productId: string; delta: number; reason: string }): Promise<Product>;
  /** The stock level at or below which a product counts as running low; null removes the alert. */
  setReorderLevel(productId: string, level: number | null): Promise<Product>;
  /** Tags a product with its HSN code and an official GST rate (null when it still needs choosing). */
  setProductGst(productId: string, tag: { hsn: string; gstRate: number | null; citation: string | null }): Promise<Product>;
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
  listSuppliers(): Promise<Supplier[]>;
  /** Orders to a supplier, by name as the wholesaler gave it, that nothing has paid yet. Newest first. */
  unpaidSupplierOrders(supplierName: string): Promise<SupplierOrderDue[]>;
  /** Pays a verified supplier through Cashfree Payouts. Only called after the owner approved. */
  paySupplier(input: { supplier: Supplier; amountPaise: Paise; supplierOrderId?: string }): Promise<SupplierPayout>;
  /** Keeps a chart Munshi drew, so the chat can show it. */
  saveChart(input: { title: string; png: Uint8Array }): Promise<{ id: string }>;
}
