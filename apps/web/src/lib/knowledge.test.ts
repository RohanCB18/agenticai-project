import { describe, expect, it, vi } from "vitest";
import { createEdgeEmbedder, createSupabaseKnowledge, SEARCH_WEIGHTS } from "./knowledge";

const source = { id: "ctr-09-2025", title: "Notification No. 9/2025-Central Tax (Rate)", gsr: "G.S.R. 641(E)", dated: "2025-09-17", effectiveFrom: "2025-09-22", url: "https://x.test/9.pdf" };
const row = (id: string, score: number, gst: string | number | null = "5.000") => ({
  id,
  kind: "rate",
  hsn: "1902",
  description: "Pasta, noodles",
  gst,
  content: `Pasta, noodles. ${id}`,
  sources: [source],
  similarity: 0.8,
  score,
});

function fakeDb(rows: ReturnType<typeof row>[]) {
  return { rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: typeof rows; error: null }>>(async () => ({ data: rows, error: null })) };
}

describe("createSupabaseKnowledge", () => {
  it("embeds the query and searches with the eval's weights", async () => {
    const db = fakeDb([row("ctr-09-2025:I:119", 0.05), row("ctr-09-2025:explanation", 0.01, null)]);
    const kb = createSupabaseKnowledge({ db: db as never, embed: async () => Array(384).fill(0.1) });
    const passages = await kb.searchGst("instant noodles", 4);

    expect(db.rpc).toHaveBeenCalledWith("match_knowledge", expect.objectContaining({ query_text: "instant noodles", match_count: 4, corpus_name: "gst", ...SEARCH_WEIGHTS }));
    const args = db.rpc.mock.calls[0]![1];
    expect(JSON.parse(args.query_embedding as string)).toHaveLength(384);
    // numeric comes back from PostgREST as a string or number; the agent gets a number.
    expect(passages).toEqual([
      { id: "ctr-09-2025:I:119", kind: "rate", hsn: "1902", description: "Pasta, noodles", gst: 5, content: "Pasta, noodles. ctr-09-2025:I:119", sources: [source] },
      expect.objectContaining({ id: "ctr-09-2025:explanation", gst: null }),
    ]);
  });

  it("still answers by keywords and HSN code when embedding fails", async () => {
    const db = fakeDb([row("ctr-19-2025:III:16", 0.03), row("ctr-09-2025:I:1", 0)]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kb = createSupabaseKnowledge({ db: db as never, embed: async () => Promise.reject(new Error("546")) });
    const passages = await kb.searchGst("HSN 2402");
    warn.mockRestore();

    expect(db.rpc.mock.calls[0]![1]).toMatchObject({ semantic_weight: 0, keyword_weight: SEARCH_WEIGHTS.keyword_weight, hsn_weight: SEARCH_WEIGHTS.hsn_weight });
    // Rows that only the (meaningless) placeholder vector ranked score 0 and are dropped.
    expect(passages.map((p) => p.id)).toEqual(["ctr-19-2025:III:16"]);
  });

  it("reports a failed search", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "function match_knowledge does not exist" } }) };
    const kb = createSupabaseKnowledge({ db: db as never, embed: async () => Array(384).fill(0) });
    await expect(kb.searchGst("rice")).rejects.toThrow("knowledge search failed");
  });
});

describe("createEdgeEmbedder", () => {
  it("sends the shared key and returns the one vector", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ embeddings: [Array(384).fill(0.5)] }));
    const embed = createEdgeEmbedder("https://db.test/functions/v1/embed", "k", fetchImpl as never);
    expect(await embed("sugar")).toHaveLength(384);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://db.test/functions/v1/embed");
    expect(new Headers(init.headers).get("x-embed-key")).toBe("k");
    expect(JSON.parse(init.body as string)).toEqual({ input: "sugar" });
  });

  it("rejects an error or a vector of the wrong size", async () => {
    await expect(createEdgeEmbedder("u", "k", (async () => new Response("no", { status: 401 })) as never)("x")).rejects.toThrow("401");
    await expect(createEdgeEmbedder("u", "k", (async () => Response.json({ embeddings: [[1, 2]] })) as never)("x")).rejects.toThrow("no vector");
  });
});
