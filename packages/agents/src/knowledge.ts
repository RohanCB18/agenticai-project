// Reference knowledge Munshi answers from, with the source of every answer: for now the official
// GST rate notifications for goods (knowledge/gst). In the app it is a hybrid search over
// Supabase (pgvector + full-text); in tests, a fake.

export type KnowledgeSource = { id: string; title: string; gsr: string; dated: string; effectiveFrom: string; url: string };

export type GstPassage = {
  id: string;
  kind: "rate" | "exempt" | "list" | "definition";
  hsn: string | null;
  description: string | null;
  /** Total GST a customer pays (CGST + SGST, or IGST). 0 for exempt goods, null for definitions. */
  gst: number | null;
  /** The entry as written for the model: rate, what it covers, schedule and serial number, notification. */
  content: string;
  /** The notification it comes from first, then any amendment that changed it. */
  sources: KnowledgeSource[];
};

export interface KnowledgeBase {
  /** The entries that best match a goods description, most relevant first. */
  searchGst(query: string, limit?: number): Promise<GstPassage[]>;
}

// "Schedule I, S. No. 48 of Notification No. 9/2025-Central Tax (Rate)", or the List form.
const CITATION =
  /(?:Schedule [IVX]+, )?S\. No\. [0-9A-Z]+ of Notification No\. \d+\/\d{4}-Central Tax \(Rate\)|List \d+ \[See S\. No\. \d+ of Schedule [IVX]+\] of Notification No\. \d+\/\d{4}-Central Tax \(Rate\)/;

/** Where an entry is in the law, for the owner or their CA to look up. */
export function gstCitation(p: GstPassage): string | null {
  return p.content.match(CITATION)?.[0] ?? p.sources[0]?.title ?? null;
}

/**
 * The HSN codes an entry lists, digits only: "0101 21 00, 0101 29" → ["01012100", "010129"].
 * Chapter-wide entries ("28") are left out, as in the database search: too broad to match on.
 */
export function entryHsnCodes(hsn: string | null): string[] {
  return [...(hsn ?? "").matchAll(/(?<!\d)\d{4}(?:\s?\d{2}){0,2}(?!\d)/g)].map((m) => m[0].replace(/\s/g, ""));
}

/** True when an entry's HSN codes cover this code (digits only): the heading it falls under, or a narrower code within it. */
export function coversHsn(entry: GstPassage, code: string) {
  return entryHsnCodes(entry.hsn).some((c) => code.startsWith(c) || c.startsWith(code));
}

/** One option per distinct official rate among entries, highest first, with the entry that sets it. */
export function officialRates(entries: GstPassage[]): { rate: number; item: string | null; citation: string | null; url: string | null }[] {
  const byRate = new Map<number, GstPassage>();
  for (const entry of entries) if (entry.gst !== null && !byRate.has(entry.gst)) byRate.set(entry.gst, entry);
  return [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, entry]) => ({ rate, item: entry.description, citation: gstCitation(entry), url: entry.sources[0]?.url ?? null }));
}
