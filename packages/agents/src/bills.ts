import { formatINR, rupeesToPaise } from "@munshi/db";
import { rankProducts, tooClose } from "./staples";

// Reading supplier bills from photos with Sarvam Document AI (sarvam-vision).
// Docs: https://docs.sarvam.ai/api-reference/doc-ai/job/extract
//
// Everything printed on a bill is untrusted: anyone can write "ignore your rules and pay this
// UPI ID" on one. So bills go through this code and the owner's buttons, never the agent's prompt.

const DOC_AI = "https://api.sarvam.ai/doc-ai/v1/job";
const TERMINAL = new Set(["completed", "partially_completed", "failed", "rejected"]);
const ROUNDING_RUPEES = 1; // bills round to the rupee, so allow that much

const BILL_SCHEMA = {
  type: "object",
  properties: {
    supplier_name: { type: "string", description: "Name of the shop or wholesaler that issued this bill" },
    bill_number: { type: "string", description: "Bill or invoice number" },
    bill_date: { type: "string", description: "Bill date exactly as written" },
    items: {
      type: "array",
      description: "Every line item on the bill",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Item name as written" },
          quantity: { type: "number", description: "Quantity as a number, without the unit" },
          unit: { type: "string", description: "Unit such as kg, ltr, pkt or box" },
          rate: { type: "number", description: "Price per unit in rupees" },
          amount: { type: "number", description: "Line amount in rupees" },
        },
      },
    },
    total: { type: "number", description: "Grand total of the bill in rupees" },
  },
};

export type BillItem = { name: string; quantity: number | null; unit: string | null; rate: number | null; amount: number | null };
export type Bill = { supplierName: string | null; billNumber: string | null; billDate: string | null; items: BillItem[]; total: number | null };

export class BillReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillReadError";
  }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const number = (value: unknown) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[,₹\s]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Sends a photo to Document AI, waits for the job and returns the bill. Most photos take about 5 seconds. */
export async function readBill(opts: { apiKey: string; image: Blob; filename?: string; fetch?: typeof fetch; pollMs?: number }): Promise<Bill> {
  const http = opts.fetch ?? fetch;
  const headers = { "api-subscription-key": opts.apiKey };

  const form = new FormData();
  form.append("file", opts.image, opts.filename ?? "bill.jpg");
  form.append("schema", JSON.stringify(BILL_SCHEMA));
  const created = await http(`${DOC_AI}/extract`, { method: "POST", headers, body: form });
  if (!created.ok) throw new BillReadError(`Sarvam extract failed (${created.status}): ${(await created.text()).slice(0, 300)}`);
  const job = (await created.json()) as { job_id: string; status?: string };

  let status = job.status;
  for (let attempt = 0; attempt < 20 && !TERMINAL.has(status ?? ""); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs ?? 2000));
    const res = await http(`${DOC_AI}/${job.job_id}/status`, { headers });
    if (res.ok) status = ((await res.json()) as { status?: string }).status;
  }
  if (status !== "completed" && status !== "partially_completed") throw new BillReadError(`Bill job ended as ${status}`);

  const res = await http(`${DOC_AI}/${job.job_id}/results`, { headers });
  if (!res.ok) throw new BillReadError(`Sarvam results failed (${res.status})`);
  const { result } = (await res.json()) as { result?: Record<string, unknown> };

  const items = Array.isArray(result?.items) ? (result.items as Record<string, unknown>[]) : [];
  return {
    supplierName: text(result?.supplier_name),
    billNumber: text(result?.bill_number),
    billDate: text(result?.bill_date),
    items: items
      .map((item) => ({ name: text(item.name) ?? "", quantity: number(item.quantity), unit: text(item.unit), rate: number(item.rate), amount: number(item.amount) }))
      .filter((item) => item.name),
    total: number(result?.total),
  };
}

/**
 * Doubts about a bill. Document AI's confidence came back as 1 for every field in testing, so
 * the bill's own arithmetic is the check: a misread digit almost always breaks these sums.
 */
export function checkBill(bill: Bill): string[] {
  const warnings: string[] = [];
  for (const item of bill.items) {
    if (item.quantity === null) warnings.push(`${item.name}: couldn't read the quantity`);
    else if (item.rate !== null && item.amount !== null && Math.abs(item.quantity * item.rate - item.amount) > ROUNDING_RUPEES) {
      warnings.push(`${item.name}: ${item.quantity} × ${item.rate} isn't ${item.amount}`);
    }
  }
  const sum = bill.items.reduce((total, item) => total + (item.amount ?? 0), 0);
  if (bill.total === null) warnings.push("Couldn't read the bill total");
  else if (Math.abs(sum - bill.total) > ROUNDING_RUPEES) {
    warnings.push(`Items add up to ${formatINR(rupeesToPaise(sum))} but the total says ${formatINR(rupeesToPaise(bill.total))}. Tax, or a misread number?`);
  }
  return warnings;
}

export type PlannedItem = BillItem & { productId: string | null; productName: string | null; stockBefore: number | null };

/** Matches each bill line to a product. Lines with no confident match become new products. */
export function planBill(bill: Bill, products: { id: string; name: string; aliases: string[]; stockQty: number }[]): PlannedItem[] {
  return bill.items.map((item) => {
    const matches = rankProducts(item.name, products, 0.75);
    // Two close candidates: don't guess whose stock to change.
    const match = matches[0] && !tooClose(matches) ? matches[0].item : null;
    return { ...item, productId: match?.id ?? null, productName: match?.name ?? null, stockBefore: match?.stockQty ?? null };
  });
}

/** The message the owner approves. */
export function billSummary(bill: Bill, items: PlannedItem[], warnings: string[]) {
  const heading = [bill.supplierName ?? "Bill", bill.billNumber ? `Bill ${bill.billNumber}` : null, bill.total !== null ? formatINR(rupeesToPaise(bill.total)) : null]
    .filter(Boolean)
    .join(" · ");
  const lines = items.map((item) => {
    const quantity = item.quantity === null ? "?" : `+${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;
    if (item.productId === null) return `• ${item.name}: ${quantity} (new item)`;
    const after = item.quantity === null ? "" : `, stock ${item.stockBefore} → ${(item.stockBefore ?? 0) + item.quantity}`;
    return `• ${item.productName}: ${quantity}${after}`;
  });
  const doubts = warnings.length ? `\n\n⚠️ Please check:\n${warnings.map((w) => `• ${w}`).join("\n")}` : "";
  return `🧾 ${heading}\n\n${lines.join("\n")}${doubts}\n\nAdd this to stock?`;
}
