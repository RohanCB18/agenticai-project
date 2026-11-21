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

// Dal by its everyday names. The corpus's common names (knowledge/gst/common_names.json) gave whole
// pulses (0713) only "chana dal" and "dried lentils", and dal flour (1106) "pulse flour": live,
// "Toor dal" found jaggery and "pulses split" found dal flour. Searched with the official wording too.
const PULSES = /\b(?:dal|daal|dhal|toor|tuvar|tur|arhar|moong|mung|urad|masoor|chana|rajma|lobia|pulses?|lentils?)\b/i;
const FLOUR = /\b(?:flour|besan|aata|atta|powder|meal|husk)\b/i;

/** The query as searched: dal and pulses also by the official words for them, unless it's their flour. */
export function withOfficialWording(query: string) {
  return PULSES.test(query) && !FLOUR.test(query) ? `${query} (dried leguminous vegetables, shelled, split)` : query;
}

// "Rice, pre-packaged and labelled" and "Rice, other than pre-packaged and labelled" are the same goods.
const PACKAGING = /\b(?:other than )?pre-?packaged and labell?ed\b/g;
const goodsWords = (text: string | null) => new Set((text ?? "").toLowerCase().replace(PACKAGING, " ").match(/[a-z]+/g) ?? []);

/**
 * True when two entries describe the same goods, told apart only by packing: loose and packed toor
 * dal, but not biscuits (1905) and plain roti (also 1905, exempt), or sugar and jaggery (both 1701).
 */
export function sameGoods(a: GstPassage, b: GstPassage) {
  const x = goodsWords(a.description);
  const y = goodsWords(b.description);
  const shared = [...x].filter((word) => y.has(word)).length;
  const all = new Set([...x, ...y]).size;
  return all > 0 && shared / all >= 0.6;
}

/**
 * The HSN code to keep: the one given, unless it is more specific than every official entry that
 * covers it, then the official one. Live, the agent tagged toor dal "07131000" (the sub-code for
 * peas) where the notification lists only 0713.
 */
export function officialHsn(entries: GstPassage[], code: string): string {
  const codes = entries.flatMap((entry) => entryHsnCodes(entry.hsn));
  if (codes.some((c) => c.startsWith(code))) return code;
  return codes.filter((c) => code.startsWith(c)).sort((a, b) => b.length - a.length)[0] ?? code;
}

/** One option per distinct official rate among entries, highest first, with the entry that sets it. */
export function officialRates(entries: GstPassage[]): { rate: number; item: string | null; citation: string | null; url: string | null }[] {
  const byRate = new Map<number, GstPassage>();
  for (const entry of entries) if (entry.gst !== null && !byRate.has(entry.gst)) byRate.set(entry.gst, entry);
  return [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([rate, entry]) => ({ rate, item: entry.description, citation: gstCitation(entry), url: entry.sources[0]?.url ?? null }));
}
