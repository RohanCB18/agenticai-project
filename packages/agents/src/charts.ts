import { formatINR, type LedgerKind } from "@munshi/db";
import type { Customer, LedgerEntry, Product } from "./store";

// Charts of the shop's own numbers. The agent writes a short Python program; the app runs it in an
// isolated sandbox (no network, no secrets) over CSV exports of the khata, and sends the owner the
// picture. Numbers come from the files, never from the model. What the model got wrong live (which
// days "is mahine" means, that udhaar is a sale, whether there is anything to draw) the app decides.

export type ChartResult = { ok: true; png: Uint8Array; stdout: string } | { ok: false; error: string; stdout?: string };

/** What a chart program prints, instead of drawing, when there is nothing to show for the question. */
export const NOTHING_TO_CHART = "NOTHING_TO_CHART";

export interface ChartRunner {
  /** Runs `code` as chart.py next to `files` and returns the chart.png it saved, or why it failed. */
  run(input: { code: string; files: Record<string, string> }): Promise<ChartResult>;
}

/** The days a chart covers, worked out by the app in India time: "this_month" is the 1st to today. */
export const CHART_PERIODS = ["this_month", "last_month", "last_7_days", "last_30_days", "last_90_days", "last_365_days"] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];

/** What a chart shows. The app checks there is something to draw before any program runs. */
export const CHART_TOPICS = ["sales", "cash_sales", "udhaar", "payments", "expenses", "stock", "other"] as const;
export type ChartTopic = (typeof CHART_TOPICS)[number];

export type ChartWindow = { from: string; to: string; label: string };

const TYPES: Record<string, string> = { credit_given: "udhaar", payment_received: "payment" };
const KINDS: LedgerKind[] = ["sale", "credit_given", "payment_received", "expense", "supplier_payment"];

/** "2026-11-19" in India time: the day the owner would say. */
const indianDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

/** "2026-11-21" moved by `days`. */
function addDays(day: string, days: number) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

export function chartWindow(period: ChartPeriod, now = new Date()): ChartWindow {
  const today = indianDay(now.toISOString());
  const monthStart = `${today.slice(0, 8)}01`;
  let from = monthStart;
  let to = today;
  if (period === "last_month") {
    to = addDays(monthStart, -1);
    from = `${to.slice(0, 8)}01`;
  } else if (period !== "this_month") {
    from = addDays(today, 1 - Number(period.split("_")[1]));
  }
  return { from, to, label: from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}` };
}

function csv(rows: (string | number | null)[][]) {
  const cell = (value: string | number | null) => {
    const text = value === null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${rows.map((row) => row.map(cell).join(",")).join("\n")}\n`;
}

type KindTotals = Record<LedgerKind, { paise: number; count: number }>;
const emptyTotals = (): KindTotals => Object.fromEntries(KINDS.map((k) => [k, { paise: 0, count: 0 }])) as KindTotals;
const rupees = (paise: number) => paise / 100;

/**
 * The files a chart program reads, cut to the window: the khata entry by entry, the same added up
 * per day (every day, sales already counting udhaar), and today's stock. Plus the window's totals,
 * counted here, for the reply.
 */
export function chartFiles(entries: LedgerEntry[], customers: Customer[], products: Product[], window: ChartWindow) {
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const inWindow = entries
    .map((entry) => ({ entry, day: indianDay(entry.createdAt) }))
    .filter(({ day }) => day >= window.from && day <= window.to)
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt));

  const totals = emptyTotals();
  const days = new Map<string, KindTotals>();
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) days.set(day, emptyTotals());
  for (const { entry, day } of inWindow) {
    for (const sums of [totals, days.get(day)!]) {
      sums[entry.kind].paise += entry.amountPaise;
      sums[entry.kind].count += 1;
    }
  }

  const ledger = inWindow.map(({ entry: e, day }) => [day, TYPES[e.kind] ?? e.kind, rupees(e.amountPaise), e.customerId ? (names.get(e.customerId) ?? "") : "", e.note]);
  const daily = [...days].map(([day, t]) => [
    day,
    rupees(t.sale.paise),
    rupees(t.credit_given.paise),
    rupees(t.sale.paise + t.credit_given.paise),
    rupees(t.payment_received.paise),
    rupees(t.expense.paise),
    rupees(t.supplier_payment.paise),
  ]);
  const stock = products.map((p) => [p.name, p.stockQty, p.unit, p.reorderLevel]);
  return {
    files: {
      "daily.csv": csv([["date", "cash_sales", "udhaar", "sales", "payments", "expenses", "supplier_payments"], ...daily]),
      "ledger.csv": csv([["date", "type", "amount", "customer", "note"], ...ledger]),
      "stock.csv": csv([["product", "stock", "unit", "reorder_at"], ...stock]),
    },
    ledgerRows: ledger.length,
    totals,
  };
}

/** Why a chart about `topic` has nothing to draw in the window, or null when it has. */
export function nothingToChart(topic: ChartTopic, totals: KindTotals, products: number, window: ChartWindow): string | null {
  const has = (...kinds: LedgerKind[]) => kinds.some((kind) => totals[kind].count > 0);
  const missing: Record<ChartTopic, [boolean, string]> = {
    sales: [has("sale", "credit_given"), "no sales or udhaar"],
    cash_sales: [has("sale"), "no cash sales"],
    udhaar: [has("credit_given"), "no udhaar given"],
    payments: [has("payment_received"), "no payments from customers"],
    expenses: [has("expense", "supplier_payment"), "no expenses"],
    stock: [products > 0, "no products in stock"],
    other: [has(...KINDS) || products > 0, "no entries in the khata"],
  };
  const [ok, what] = missing[topic];
  if (ok) return null;
  return topic === "stock" ? what : `${what} (${window.label})`;
}

/** The window's totals in rupees, as the owner reads them: what the reply's numbers come from. */
export function chartTotals(totals: KindTotals) {
  return {
    sales: formatINR(totals.sale.paise + totals.credit_given.paise),
    cashSales: formatINR(totals.sale.paise),
    udhaar: formatINR(totals.credit_given.paise),
    paymentsReceived: formatINR(totals.payment_received.paise),
    expenses: formatINR(totals.expense.paise),
    supplierPayments: formatINR(totals.supplier_payment.paise),
  };
}

/**
 * A sales chart that never looks at udhaar is wrong in a kirana (live, it drew "No sales data" over
 * a month of udhaar). Caught before it runs, so the agent fixes the program instead of the owner
 * getting a wrong picture.
 */
export function salesChartSkipsUdhaar(topic: ChartTopic, code: string) {
  return topic === "sales" && !/udhaar|["']sales["']/.test(code);
}

/** What the agent is told about the program it writes: the files, the output, the limits. */
export const CHART_CODE_GUIDE = `A short Python 3 program using pandas and matplotlib (the Agg backend is already set). It reads these files from its working directory, already cut to the period asked for, and saves one chart to chart.png:
- daily.csv: one row per day of the period, oldest first, amounts in rupees: date (YYYY-MM-DD), cash_sales, udhaar (goods given on credit), sales (cash_sales + udhaar), payments (money customers paid back), expenses, supplier_payments. Use it for anything over time.
- ledger.csv: every entry: date, type (udhaar, payment, sale, expense, supplier_payment), amount (rupees), customer (empty for sales and expenses), note. Use it for per-customer charts.
- stock.csv: product, stock, unit, reorder_at (empty if no alert)
In a kirana, goods given on credit are sales too: a sales chart draws daily.csv's cash_sales and udhaar as stacked bars per day, unless the owner says cash only. Don't filter the dates again: the files hold exactly the period.
Use English labels and "Rs" for rupees: the font has no Indian scripts. One chart, figsize (8, 4.5), plt.tight_layout(), plt.savefig("chart.png", dpi=150). There is no internet. Finally print one line with the key numbers (totals, highest day), for your reply.
If the rows for what was asked are empty, don't draw an empty chart: save nothing and print one line starting with ${NOTHING_TO_CHART}: and saying what is missing.`;
