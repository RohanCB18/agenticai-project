import { formatINR } from "@munshi/db";
import type { LedgerEntry } from "./store";

// Payment habits worked out from the ledger, never stored or guessed: "Fatima usually pays on
// Saturdays" is only said when her payments actually show it.

const MIN_PAYMENTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PaymentHabits =
  | { enough: false; payments: number }
  | {
      enough: true;
      payments: number;
      /** Set only when at least half of the payments fell on the same weekday. */
      usualDay: string | null;
      averageGapDays: number;
      averagePayment: string;
      lastPaidDaysAgo: number;
    };

const weekday = (iso: string) => new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: "Asia/Kolkata" }).format(new Date(iso));

export function paymentHabits(entries: LedgerEntry[], now = new Date()): PaymentHabits {
  const payments = entries
    .filter((entry) => entry.kind === "payment_received")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (payments.length < MIN_PAYMENTS) return { enough: false, payments: payments.length };

  const days = new Map<string, number>();
  for (const payment of payments) days.set(weekday(payment.createdAt), (days.get(weekday(payment.createdAt)) ?? 0) + 1);
  const [topDay, topCount] = [...days.entries()].sort((a, b) => b[1] - a[1])[0]!;

  const gaps = payments.slice(1).map((payment, i) => (Date.parse(payment.createdAt) - Date.parse(payments[i]!.createdAt)) / DAY_MS);
  const total = payments.reduce((sum, payment) => sum + payment.amountPaise, 0);

  return {
    enough: true,
    payments: payments.length,
    usualDay: topCount / payments.length >= 0.5 ? topDay : null,
    averageGapDays: Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length),
    averagePayment: formatINR(Math.round(total / payments.length)),
    lastPaidDaysAgo: Math.floor((now.getTime() - Date.parse(payments.at(-1)!.createdAt)) / DAY_MS),
  };
}
