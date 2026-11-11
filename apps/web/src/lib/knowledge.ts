import "server-only";
import type { GstPassage, KnowledgeBase, KnowledgeSource } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

// Munshi's reference knowledge (official GST rate notifications) in Supabase: the query is
// embedded with gte-small by the `embed` Edge Function, then match_knowledge fuses vector,
// full-text and exact-HSN rankings (supabase/migrations/20261110000000_knowledge.sql).

/**
 * match_knowledge's weights: meaning, keywords and HSN codes. Picked on the eval's dev questions
 * (scripts/eval-knowledge.mjs); keywords below 0.25 lost the owners' Hindi words, above it they
 * crowded out better matches.
 */
export const SEARCH_WEIGHTS = { semantic_weight: 1, keyword_weight: 0.25, hsn_weight: 2 } as const;

const DIMENSIONS = 384; // gte-small

export type Embed = (text: string) => Promise<number[]>;

/** Embeds one text with the `embed` Edge Function. */
export function createEdgeEmbedder(url: string, key: string, fetchImpl: typeof fetch = fetch): Embed {
  return async (text) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-embed-key": key },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`embed failed: ${response.status}`);
    const vector = ((await response.json()) as { embeddings?: number[][] }).embeddings?.[0];
    if (!Array.isArray(vector) || vector.length !== DIMENSIONS) throw new Error("embed returned no vector");
    return vector;
  };
}

type Row = {
  id: string;
  kind: GstPassage["kind"];
  hsn: string | null;
  description: string | null;
  gst: number | string | null;
  content: string;
  sources: KnowledgeSource[];
  score: number;
};

// If embedding fails, keyword and HSN search still answer: any valid vector, with its weight at zero.
const PLACEHOLDER_VECTOR = JSON.stringify([1, ...Array<number>(DIMENSIONS - 1).fill(0)]);

export function createSupabaseKnowledge({ db, embed }: { db: Pick<SupabaseClient, "rpc">; embed: Embed }): KnowledgeBase {
  return {
    async searchGst(query, limit = 5) {
      let vector: string | null = null;
      try {
        vector = JSON.stringify(await embed(query));
      } catch (error) {
        console.warn("[munshi] couldn't embed the GST query, searching by keywords only:", error instanceof Error ? error.message : error);
      }
      const { data, error } = await db.rpc("match_knowledge", {
        query_embedding: vector ?? PLACEHOLDER_VECTOR,
        query_text: query,
        match_count: limit,
        corpus_name: "gst",
        ...SEARCH_WEIGHTS,
        ...(vector ? {} : { semantic_weight: 0 }),
      });
      if (error) throw new Error(`knowledge search failed: ${error.message}`);
      return ((data ?? []) as Row[])
        .filter((row) => row.score > 0)
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          hsn: row.hsn,
          description: row.description,
          gst: row.gst === null ? null : Number(row.gst),
          content: row.content,
          sources: row.sources,
        }));
    },
  };
}

/** The GST knowledge base, when SUPABASE_EMBED_KEY is set (the `embed` function's shared key). */
export function configuredKnowledge(): KnowledgeBase | undefined {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_EMBED_KEY;
  if (!base || !key || !process.env.SUPABASE_SECRET_KEY) return undefined;
  const url = process.env.SUPABASE_EMBED_URL ?? `${base}/functions/v1/embed`;
  // Public reference data, the same for every shop: read with the server's client.
  return createSupabaseKnowledge({ db: createAdminClient(), embed: createEdgeEmbedder(url, key) });
}
