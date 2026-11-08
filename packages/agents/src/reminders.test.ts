import { describe, expect, it } from "vitest";
import { oldestUnpaidSince, pickReminders, remindersSummary, type ReminderCandidate } from "./reminders";
import type { LedgerEntry } from "./store";

const NOW = new Date("2026-11-08T13:30:00Z"); // a Sunday evening in India
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
let seq = 0;
const credit = (rupees: number, ago: number): LedgerEntry => ({ id: `e${++seq}`, kind: "credit_given", amountPaise: rupees * 100, customerId: "c", note: null, createdAt: daysAgo(ago) });
const paid = (rupees: number, ago: number): LedgerEntry => ({ id: `e${++seq}`, kind: "payment_received", amountPaise: rupees * 100, customerId: "c", note: null, createdAt: daysAgo(ago) });

function candidate(name: string, entries: LedgerEntry[], extra: Partial<ReminderCandidate> = {}): ReminderCandidate {
  const outstandingPaise = entries.reduce((sum, e) => sum + (e.kind === "credit_given" ? e.amountPaise : -e.amountPaise), 0);
  return { customerId: name.toLowerCase(), name, phone: "+919800000001", outstandingPaise, entries, openRequest: false, lastAskedAt: null, ...extra };
}

describe("oldestUnpaidSince", () => {
  it("clears the oldest udhaar first", () => {
    const entries = [credit(100, 20), credit(200, 10), paid(150, 5)];
    expect(oldestUnpaidSince(entries)).toBe(entries[1]!.createdAt); // the 100 is paid, the 200 isn't
    expect(oldestUnpaidSince([credit(100, 20), paid(100, 1)])).toBeNull();
  });
});

describe("pickReminders", () => {
  it("reminds about udhaar older than a week, biggest first", () => {
    const picked = pickReminders([candidate("Ramesh", [credit(300, 9)]), candidate("Fatima", [credit(900, 12)])], NOW);
    expect(picked.map((r) => [r.name, r.amount, r.reason])).toEqual([
      ["Fatima", "₹900", "udhaar unpaid for 12 days"],
      ["Ramesh", "₹300", "udhaar unpaid for 9 days"],
    ]);
  });

  it("leaves fresh udhaar, small dues, open links and recent asks alone", () => {
    expect(
      pickReminders(
        [
          candidate("Fresh", [credit(500, 2)]),
          candidate("Small", [credit(40, 30)]),
          candidate("Linked", [credit(500, 30)], { openRequest: true }),
          candidate("AskedYesterday", [credit(500, 30)], { lastAskedAt: daysAgo(1) }),
        ],
        NOW,
      ),
    ).toEqual([]);
    expect(pickReminders([candidate("AskedLastWeek", [credit(500, 30)], { lastAskedAt: daysAgo(6) })], NOW)).toHaveLength(1);
  });

  it("knows a regular payer is late before a week is up", () => {
    // Pays every 5 days; last paid 8 days ago; the open udhaar is only 6 days old.
    const regular = [credit(1000, 30), paid(100, 23), paid(100, 18), paid(100, 13), paid(100, 8), credit(200, 6)];
    const [picked] = pickReminders([candidate("Lakshmi", regular)], NOW);
    expect(picked?.reason).toBe("usually pays every 5 days, last paid 8 days ago");
  });

  it("caps the list at ten", () => {
    const many = Array.from({ length: 14 }, (_, i) => candidate(`C${i}`, [credit(100 + i, 10)]));
    expect(pickReminders(many, NOW)).toHaveLength(10);
  });
});

describe("remindersSummary", () => {
  it("says who, how much, why, and what yes will do", () => {
    const summary = remindersSummary(pickReminders([candidate("Fatima", [credit(900, 12)]), candidate("Anand", [credit(300, 9)], { phone: null })], NOW));
    expect(summary).toContain("2 customers owe ₹1,200");
    expect(summary).toContain("• Fatima: ₹900 (udhaar unpaid for 12 days)");
    expect(summary).toContain("Anand: ₹300 (udhaar unpaid for 9 days) · no phone, collect in person");
    expect(summary).toContain("payment links for the 1 with a phone number");
  });
});
