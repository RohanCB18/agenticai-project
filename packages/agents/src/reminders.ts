import { formatINR } from "@munshi/db";
import { paymentHabits, weekday } from "./habits";
import type { LedgerEntry } from "./store";

// Who to remind about udhaar today. Plain code, not a model: the owner sees exactly why each
// name is on the list, and the same ledger always gives the same list.

export type ReminderCandidate = {
  customerId: string;
  name: string;
  phone: string | null;
  outstandingPaise: number;
  /** This customer's ledger, any order. */
  entries: LedgerEntry[];
  /** An active payment link or QR already asks them for money. */
  openRequest: boolean;
  /** When a link or QR was last made for them, if ever. */
  lastAskedAt: string | null;
};

export type Reminder = { customerId: string; name: string; phone: string | null; amountPaise: number; amount: string; reason: string };

/** ₹50: below this a reminder costs more goodwill than it brings in. */
export const REMINDER_MIN_PAISE = 5_000;
const QUIET_DAYS = 3; // never ask the same customer twice in three days
const STALE_DAYS = 7; // udhaar older than a week is worth a nudge
const LATE_DAYS = 2; // days past their usual gap before they count as late
const MAX_REMINDERS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysBetween = (from: string | number, to: Date) => Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS);

/** When the oldest udhaar not yet covered by payments was given (payments clear the oldest first). */
export function oldestUnpaidSince(entries: LedgerEntry[]): string | null {
  let paid = entries.filter((e) => e.kind === "payment_received").reduce((sum, e) => sum + e.amountPaise, 0);
  const credits = entries.filter((e) => e.kind === "credit_given").sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const credit of credits) {
    if (paid >= credit.amountPaise) paid -= credit.amountPaise;
    else return credit.createdAt;
  }
  return null;
}

/** The customers worth reminding today, biggest dues first, each with the reason in plain words. */
export function pickReminders(candidates: ReminderCandidate[], now = new Date()): Reminder[] {
  const due: Reminder[] = [];
  for (const c of candidates) {
    if (c.outstandingPaise < REMINDER_MIN_PAISE || c.openRequest) continue;
    if (c.lastAskedAt && daysBetween(c.lastAskedAt, now) < QUIET_DAYS) continue;

    const habits = paymentHabits(c.entries, now);
    const unpaidSince = oldestUnpaidSince(c.entries);
    const unpaidDays = unpaidSince ? daysBetween(unpaidSince, now) : 0;
    let reason: string | null = null;
    if (habits.enough && habits.lastPaidDaysAgo - habits.averageGapDays >= LATE_DAYS) {
      reason = `usually pays every ${habits.averageGapDays} days, last paid ${habits.lastPaidDaysAgo} days ago`;
    } else if (habits.enough && habits.usualDay && habits.usualDay === weekday(now.toISOString())) {
      reason = `usually pays on ${habits.usualDay}`;
    } else if (unpaidDays >= STALE_DAYS) {
      reason = `udhaar unpaid for ${unpaidDays} days`;
    }
    if (reason) due.push({ customerId: c.customerId, name: c.name, phone: c.phone, amountPaise: c.outstandingPaise, amount: formatINR(c.outstandingPaise), reason });
  }
  return due.sort((a, b) => b.amountPaise - a.amountPaise).slice(0, MAX_REMINDERS);
}

/** The owner's message: who, how much, why, and what tapping yes will do. */
export function remindersSummary(reminders: Reminder[]): string {
  const total = formatINR(reminders.reduce((sum, r) => sum + r.amountPaise, 0));
  const lines = reminders.map((r) => `• ${r.name}: ${r.amount} (${r.reason})${r.phone ? "" : " · no phone, collect in person"}`);
  const withPhone = reminders.filter((r) => r.phone).length;
  return [
    `🔔 Udhaar reminders: ${reminders.length} ${reminders.length === 1 ? "customer owes" : "customers owe"} ${total}`,
    "",
    ...lines,
    "",
    withPhone ? `Make UPI payment links for the ${withPhone} with a phone number? You'll get each link with a button to send it on WhatsApp.` : "None of them has a phone number, so there's nothing to send.",
  ].join("\n");
}
