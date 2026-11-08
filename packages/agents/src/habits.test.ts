import { describe, expect, it } from "vitest";
import { paymentHabits } from "./habits";
import type { LedgerEntry } from "./store";

const pay = (iso: string, rupees: number, kind: LedgerEntry["kind"] = "payment_received"): LedgerEntry => ({
  id: iso,
  kind,
  amountPaise: rupees * 100,
  customerId: "c",
  note: null,
  createdAt: iso,
});

// Saturdays in IST (evening, so UTC is still the same day).
const saturdays = [pay("2026-10-17T12:00:00Z", 200), pay("2026-10-24T12:00:00Z", 300), pay("2026-10-31T12:00:00Z", 400)];

describe("paymentHabits", () => {
  it("finds the usual day, the gap and the average", () => {
    expect(paymentHabits([...saturdays, pay("2026-10-20T12:00:00Z", 999, "credit_given")], new Date("2026-11-03T12:00:00Z"))).toEqual({
      enough: true,
      payments: 3,
      usualDay: "Saturday",
      averageGapDays: 7,
      averagePayment: "₹300",
      lastPaidDaysAgo: 3,
    });
  });

  it("names no usual day when payments are spread out", () => {
    const spread = [pay("2026-10-12T12:00:00Z", 100), pay("2026-10-14T12:00:00Z", 100), pay("2026-10-16T12:00:00Z", 100), pay("2026-10-17T12:00:00Z", 100)];
    expect(paymentHabits(spread)).toMatchObject({ enough: true, usualDay: null });
  });

  it("refuses to guess from too little history", () => {
    expect(paymentHabits(saturdays.slice(0, 2))).toEqual({ enough: false, payments: 2 });
  });

  it("uses Indian time for the weekday", () => {
    // 20:00 UTC on a Friday is 01:30 on Saturday in India.
    const lateFridays = [pay("2026-10-16T20:00:00Z", 100), pay("2026-10-23T20:00:00Z", 100), pay("2026-10-30T20:00:00Z", 100)];
    expect(paymentHabits(lateFridays)).toMatchObject({ usualDay: "Saturday" });
  });
});
