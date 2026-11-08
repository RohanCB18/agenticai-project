import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { indiaDateKey, loadCandidates, planReminders, remindersReport, whatsappButton } from "./reminders";

const NOW = new Date("2026-11-08T13:30:00Z"); // 7 pm in India
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const M = "shop-1";

type Row = Record<string, unknown>;

/** Just enough of the Supabase query builder for these reads: eq, in, gte, order, range, single. */
function fakeDb(tables: Record<string, Row[]>, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(table);
      let rows = [...(tables[table] ?? [])];
      let page: [number, number] | null = null;
      const query = {
        select: () => query,
        eq: (col: string, value: unknown) => ((rows = rows.filter((r) => r[col] === value)), query),
        in: (col: string, values: unknown[]) => ((rows = rows.filter((r) => values.includes(r[col]))), query),
        gte: (col: string, value: number | string) => ((rows = rows.filter((r) => (r[col] as number | string) >= value)), query),
        order: () => query,
        range: (from: number, to: number) => ((page = [from, to]), query),
        single: async () => (rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "no rows" } }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => resolve({ data: page ? rows.slice(page[0], page[1] + 1) : rows, error: null }),
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

const entry = (customer: string, kind: string, rupees: number, ago: number, merchant = M) => ({
  id: `${customer}-${kind}-${ago}`,
  merchant_id: merchant,
  customer_id: customer,
  kind,
  amount_paise: rupees * 100,
  note: null,
  created_at: daysAgo(ago),
});

function shop() {
  return {
    merchants: [{ id: M, shop_name: "Sri Ganesh Stores" }],
    customer_balances: [
      { merchant_id: M, customer_id: "fatima", name: "Fatima", outstanding_paise: 90000 },
      { merchant_id: M, customer_id: "ramesh", name: "Ramesh", outstanding_paise: 30000 },
      { merchant_id: M, customer_id: "anand", name: "Anand", outstanding_paise: 50000 },
      { merchant_id: M, customer_id: "small", name: "Small", outstanding_paise: 4000 },
      { merchant_id: "other-shop", customer_id: "x", name: "Not ours", outstanding_paise: 99900 },
    ],
    customers: [
      { merchant_id: M, id: "fatima", phone: "+91 98000 00002" },
      { merchant_id: M, id: "ramesh", phone: "+919800000001" },
      { merchant_id: M, id: "anand", phone: null },
    ],
    ledger_entries: [
      entry("fatima", "credit_given", 900, 12),
      entry("ramesh", "credit_given", 300, 9),
      entry("anand", "credit_given", 500, 20),
      entry("x", "credit_given", 999, 30, "other-shop"),
    ],
    payment_links: [
      // Ramesh got a link yesterday: asked recently, and it's still open.
      { merchant_id: M, customer_id: "ramesh", status: "active", expires_at: daysAgo(-2), created_at: daysAgo(1) },
    ],
    payment_qrs: [
      // An old QR for Fatima expired long ago: it doesn't stop a reminder.
      { merchant_id: M, customer_id: "fatima", status: "expired", expires_at: daysAgo(5), created_at: daysAgo(5) },
    ],
  };
}

describe("loadCandidates", () => {
  it("reads this shop's customers who owe at least ₹50, with their ledger and open requests", async () => {
    const candidates = await loadCandidates(fakeDb(shop()), M, NOW);
    expect(candidates.map((c) => c.name)).toEqual(["Fatima", "Ramesh", "Anand"]);
    const [fatima, ramesh, anand] = candidates;
    expect(fatima).toMatchObject({ phone: "+91 98000 00002", outstandingPaise: 90000, openRequest: false, lastAskedAt: daysAgo(5) });
    expect(fatima!.entries).toEqual([{ id: "fatima-credit_given-12", kind: "credit_given", amountPaise: 90000, customerId: "fatima", note: null, createdAt: daysAgo(12) }]);
    expect(ramesh).toMatchObject({ openRequest: true, lastAskedAt: daysAgo(1) });
    expect(anand).toMatchObject({ phone: null, openRequest: false, lastAskedAt: null });
  });

  it("reads nothing more when nobody owes enough", async () => {
    const seen: string[] = [];
    const tables = shop();
    tables.customer_balances = tables.customer_balances.filter((b) => b.outstanding_paise < 5000);
    expect(await loadCandidates(fakeDb(tables, seen), M, NOW)).toEqual([]);
    expect(seen).toEqual(["customer_balances"]);
  });
});

describe("planReminders", () => {
  it("skips customers with an open link and explains the rest", async () => {
    const plan = await planReminders(fakeDb(shop()), M, NOW);
    expect(plan.shopName).toBe("Sri Ganesh Stores");
    expect(plan.reminders.map((r) => [r.name, r.amount, r.reason])).toEqual([
      ["Fatima", "₹900", "udhaar unpaid for 12 days"],
      ["Anand", "₹500", "udhaar unpaid for 20 days"],
    ]);
    expect(plan.summary).toContain("Anand: ₹500 (udhaar unpaid for 20 days) · no phone, collect in person");
  });
});

describe("remindersReport", () => {
  it("lists each link with a WhatsApp button, and says why any are missing", () => {
    const { text, buttons } = remindersReport("Sri Ganesh Stores", [
      { name: "Fatima", phone: "+91 98000 00002", amount: "₹900", url: "https://pay.example/f" },
      { name: "Lakshmi", phone: "+919800000003", amount: "₹0", url: null, problem: "paid since the list went out" },
    ]);
    expect(text).toBe("✅ 1 payment link ready. Tap a button to send each one on WhatsApp.\n\n• Fatima: ₹900\n  https://pay.example/f\n• Lakshmi: paid since the list went out");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.url).toBe(
      `https://wa.me/919800000002?text=${encodeURIComponent("Namaste Fatima, Sri Ganesh Stores ka ₹900 baaki hai. UPI se yahan pay karein: https://pay.example/f")}`,
    );
  });

  it("says plainly when no link was made", () => {
    expect(remindersReport("Shop", [{ name: "A", phone: "1", amount: "₹60", url: null, problem: "no phone number" }]).text).toMatch(/^No payment links were made\./);
  });
});

describe("helpers", () => {
  it("dates the evening list by the day in India, not in UTC", () => {
    expect(indiaDateKey(new Date("2026-11-08T13:30:00Z"))).toBe("20261108");
    expect(indiaDateKey(new Date("2026-11-08T19:00:00Z"))).toBe("20261109"); // 00:30 on the 9th in India
  });

  it("leaves the WhatsApp number empty when the customer has none", () => {
    expect(whatsappButton("Anand", null, "hi").url).toBe("https://wa.me/?text=hi");
  });
});
