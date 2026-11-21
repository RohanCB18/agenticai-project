import { formatINR, rupeesToPaise } from "@munshi/db";
import type { Bill, BillItem } from "./bills";
import { coversHsn, type KnowledgeBase, officialRates } from "./knowledge";

// Checks a wholesaler's bill against the official GST rates: a line charged more GST than every
// official entry for its HSN code is flagged, with the entry to cite. Code decides, not a model:
// bill text is untrusted, and rates are looked up, never recalled.
//
// Only lines that print an HSN code are checked. Matching on the item name alone can pick the
// wrong entry, and a wrong "your supplier overcharged you" costs more than a missed one.

/** The rate notifications in the knowledge base are in force from this day. */
export const GST_RATES_FROM = "2025-09-22";

export type GstOvercharge = {
  item: string;
  hsn: string;
  charged: number;
  /** The highest rate any official entry for this HSN code allows. */
  official: number;
  citation: string | null;
  url: string | null;
  /** Roughly how much more GST was charged on this line, in rupees, when the line amount is known. */
  extraRupees: number | null;
};

export type BillGstCheck =
  | { status: "checked"; checked: number; overcharged: GstOvercharge[]; withoutHsn: number; noEntry: string[] }
  | { status: "before_rate_change"; billDate: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A bill date as printed ("12/10/2025", "12-Oct-25", "2025-10-12") as YYYY-MM-DD, or null. Indian bills put the day first. */
export function billDateIso(text: string | null): string | null {
  const t = text?.trim().toLowerCase() ?? "";
  const ymd = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymd) return isoDate(+ymd[1]!, +ymd[2]!, +ymd[3]!);
  const dmy = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[-/.\s]+(\d{1,2}|[a-z]{3,9})[-/.\s,]+(\d{4}|\d{2})(?!\d)/);
  if (!dmy) return null;
  const month = /\d/.test(dmy[2]!) ? +dmy[2]! : MONTHS.indexOf(dmy[2]!.slice(0, 3)) + 1;
  const year = dmy[3]!.length === 2 ? 2000 + +dmy[3]! : +dmy[3]!;
  return isoDate(year, month, +dmy[1]!);
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function inBatches<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) results.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  return results;
}

/** The official rates for an HSN code, highest first: one per distinct rate, with the entry that sets it. */
export type OfficialRates = ReturnType<typeof officialRates>;

/**
 * The official rates for every HSN code printed on a bill, looked up once per code. Used to check
 * what the bill charged, and to tag products when the owner approves it (codes don't change with
 * the rates, so this holds for old bills too). A code no entry covers maps to an empty list.
 */
export async function officialRatesByHsn(bill: Bill, knowledge: KnowledgeBase): Promise<Record<string, OfficialRates>> {
  const codes = [...new Set(bill.items.flatMap((item) => (item.hsn ? [item.hsn] : [])))];
  const found = await inBatches(codes, 4, async (code) => {
    // The query carries the item name too, for the meaning-based half of the search.
    const name = bill.items.find((item) => item.hsn === code)!.name;
    const entries = await knowledge.searchGst(`${code} ${name}`, 10);
    return [code, officialRates(entries.filter((entry) => coversHsn(entry, code)))] as const;
  });
  return Object.fromEntries(found);
}

/**
 * Compares the GST charged on each line with the official rates for its HSN code. Null when the
 * bill shows no GST rates at all. Loose and packed goods can differ (rice: 0% loose, 5% packed),
 * so a line is flagged only above the highest rate any entry for its code allows.
 */
export function compareBillGst(bill: Bill, official: Record<string, OfficialRates>): BillGstCheck | null {
  const taxed = bill.items.filter((item): item is BillItem & { gstRate: number } => typeof item.gstRate === "number" && item.gstRate > 0);
  if (taxed.length === 0) return null;
  const date = billDateIso(bill.billDate);
  if (date && date < GST_RATES_FROM) return { status: "before_rate_change", billDate: bill.billDate! };

  const withHsn = taxed.filter((item): item is typeof item & { hsn: string } => Boolean(item.hsn));
  const overcharged: GstOvercharge[] = [];
  const noEntry: string[] = [];
  let checked = 0;
  for (const item of withHsn) {
    const [highest] = official[item.hsn] ?? [];
    if (!highest) {
      noEntry.push(item.name);
      continue;
    }
    checked++;
    if (item.gstRate <= highest.rate + 0.001) continue;
    overcharged.push({
      item: item.name,
      hsn: item.hsn,
      charged: item.gstRate,
      official: highest.rate,
      citation: highest.citation,
      url: highest.url,
      extraRupees: item.amount === null ? null : Math.round((item.amount * (item.gstRate - highest.rate)) / 100),
    });
  }
  return { status: "checked", checked, overcharged, withoutHsn: taxed.length - withHsn.length, noEntry };
}

/**
 * The GST tag a bill line gives its product: the line's HSN code, and the official rate when every
 * entry for that code agrees on one or, where they differ (biscuits 5% and plain roti 0% under
 * 1905), when the bill charged one of them. Live, sugar and Parle-G billed at 5% were left "rate to
 * choose". A rate that isn't official (toor dal billed at 18%) picks nothing: the owner chooses.
 */
export function billLineGstTag(hsn: string | null | undefined, official: Record<string, OfficialRates> | null, charged: number | null = null) {
  const rates = hsn ? (official?.[hsn] ?? []) : [];
  const chosen = rates.length === 1 ? rates[0] : charged === null ? undefined : rates.find((r) => Math.abs(r.rate - charged) < 0.001);
  return { hsn: hsn ?? null, gstRate: chosen?.rate ?? null, citation: chosen?.citation ?? null };
}

/** Looks up a bill's HSN codes and compares what it charged. */
export async function checkBillGst(bill: Bill, knowledge: KnowledgeBase): Promise<BillGstCheck | null> {
  return compareBillGst(bill, await officialRatesByHsn(bill, knowledge));
}

const percent = (rate: number) => `${rate}%`;
const plural = (n: number, word: string) => `${n} item${n === 1 ? "" : "s"}${word}`;

/** One line per overcharged item, for the owner and for the bill's saved warnings. */
export function overchargeLine(o: GstOvercharge) {
  const extra = o.extraRupees ? `, about ${formatINR(rupeesToPaise(o.extraRupees))} extra` : "";
  return `${o.item} (HSN ${o.hsn}): ${percent(o.charged)} GST charged, official ${percent(o.official)}${extra}. ${o.citation ?? ""}`.trim();
}

/** The GST part of the bill message. Empty when there was nothing to check. */
export function billGstSummary(check: BillGstCheck | null, supplierName: string | null): string {
  if (!check) return "";
  if (check.status === "before_rate_change") return `🔎 GST not checked: this bill (${check.billDate}) is from before the 22 Sep 2025 rate change.`;

  const skipped = [
    check.withoutHsn ? `${plural(check.withoutHsn, "")} without an HSN code` : null,
    check.noEntry.length ? `${check.noEntry.join(", ")} (no official entry found for the HSN code)` : null,
  ].filter(Boolean);
  const notChecked = skipped.length ? `\nNot checked: ${skipped.join("; ")}.` : "";

  if (check.overcharged.length) {
    const lines = check.overcharged.map((o) => `• ${overchargeLine(o)}`).join("\n");
    return `🔎 GST higher than the official rate on ${plural(check.overcharged.length, "")}:\n${lines}\nAsk ${supplierName ?? "the supplier"} for a corrected bill or a credit note, or check with your CA.${notChecked}`;
  }
  if (check.checked) return `🔎 GST: ${check.checked === 1 ? "the item" : `all ${check.checked} items`} with an HSN code ${check.checked === 1 ? "matches" : "match"} the official rates.${notChecked}`;
  return `🔎 GST not checked: ${skipped.join("; ")}.`;
}
