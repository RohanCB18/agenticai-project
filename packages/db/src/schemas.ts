import { z } from "zod";

// Mirrors the enums in supabase/migrations. Agents validate tool input with these.

export const Language = z.enum(["kn", "hi", "ta", "bn", "en"]);
export type Language = z.infer<typeof Language>;

export const LedgerKind = z.enum([
  "credit_given", // udhaar: customer took goods on credit
  "payment_received", // customer paid back (cash, UPI, payment link)
  "sale", // cash/UPI sale, no credit
  "expense",
  "supplier_payment",
]);
export type LedgerKind = z.infer<typeof LedgerKind>;

export const EntrySource = z.enum(["voice", "chat", "whatsapp", "webhook", "system"]);
export type EntrySource = z.infer<typeof EntrySource>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired", "executed", "failed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const ApprovalAction = z.enum(["payment_link", "supplier_payout", "purchase_order", "reminder_campaign"]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

export const NewLedgerEntry = z.object({
  kind: LedgerKind,
  amountPaise: z.number().int().positive().max(10_000_000_00), // ₹1 crore ceiling per entry
  customerId: z.uuid().optional(),
  note: z.string().max(500).optional(),
  source: EntrySource,
});
export type NewLedgerEntry = z.infer<typeof NewLedgerEntry>;
