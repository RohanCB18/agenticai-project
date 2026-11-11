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
