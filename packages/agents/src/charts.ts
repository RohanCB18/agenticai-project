import type { Customer, LedgerEntry, Product } from "./store";

// Charts of the shop's own numbers. The agent writes a short Python program; the app runs it in an
// isolated sandbox (no network, no secrets) over CSV exports of the khata, and sends the owner the
// picture. Numbers come from the files, never from the model.

export type ChartResult = { ok: true; png: Uint8Array; stdout: string } | { ok: false; error: string };

export interface ChartRunner {
  /** Runs `code` as chart.py next to `files` and returns the chart.png it saved, or why it failed. */
  run(input: { code: string; files: Record<string, string> }): Promise<ChartResult>;
}

const TYPES: Record<string, string> = { credit_given: "udhaar", payment_received: "payment" };

/** "2026-11-19" in India time: the day the owner would say. */
const indianDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

function csv(rows: (string | number | null)[][]) {
  const cell = (value: string | number | null) => {
    const text = value === null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${rows.map((row) => row.map(cell).join(",")).join("\n")}\n`;
}

/** The files a chart program reads: the last `days` of the khata, and today's stock. */
export function chartFiles(entries: LedgerEntry[], customers: Customer[], products: Product[], days: number, now = new Date()) {
  const since = now.getTime() - days * 86_400_000;
  const names = new Map(customers.map((c) => [c.id, c.name]));
  const ledger = entries
    .filter((e) => Date.parse(e.createdAt) >= since)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e) => [indianDay(e.createdAt), TYPES[e.kind] ?? e.kind, e.amountPaise / 100, e.customerId ? (names.get(e.customerId) ?? "") : "", e.note]);
  const stock = products.map((p) => [p.name, p.stockQty, p.unit, p.reorderLevel]);
  return {
    files: {
      "ledger.csv": csv([["date", "type", "amount", "customer", "note"], ...ledger]),
      "stock.csv": csv([["product", "stock", "unit", "reorder_at"], ...stock]),
    },
    ledgerRows: ledger.length,
  };
}

/** What the agent is told about the program it writes: the files, the output, the limits. */
export const CHART_CODE_GUIDE = `A short Python 3 program using pandas and matplotlib (the Agg backend is already set). It reads these files from its working directory and saves one chart to chart.png:
- ledger.csv: date (YYYY-MM-DD, India time), type (udhaar, payment, sale, expense, supplier_payment), amount (rupees), customer (empty for sales and expenses), note
- stock.csv: product, stock, unit, reorder_at (empty if no alert)
Use English labels and "Rs" for rupees: the font has no Indian scripts. One chart, figsize (8, 4.5), plt.tight_layout(), plt.savefig("chart.png", dpi=150). There is no internet. Finally print one line with the key numbers (totals, highest day), for your reply.`;
