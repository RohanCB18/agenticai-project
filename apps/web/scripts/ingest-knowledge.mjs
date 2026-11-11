// Loads knowledge/gst/chunks.jsonl into knowledge_chunks, with gte-small embeddings from the
// `embed` Edge Function. Safe to re-run: chunks already stored with the same text are skipped,
// changed ones are re-embedded, and rows are upserted by id.
//
// Run from apps/web:  node --env-file=.env.local scripts/ingest-knowledge.mjs
// Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_EMBED_KEY.
// KNOWLEDGE_SUPABASE_URL / KNOWLEDGE_SUPABASE_SECRET_KEY / SUPABASE_EMBED_URL override them (local stack).
// To compare builds, KNOWLEDGE_CHUNKS loads another chunks file as corpus KNOWLEDGE_CORPUS, with
// ids prefixed by the corpus name so it sits beside "gst"; eval-knowledge.mjs --corpus scores it.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const url = process.env.KNOWLEDGE_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.KNOWLEDGE_SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY;
const embedKey = process.env.SUPABASE_EMBED_KEY;
const embedUrl = process.env.SUPABASE_EMBED_URL ?? `${url}/functions/v1/embed`;
if (!url || !secret || !embedKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_EMBED_KEY (see apps/web/.env.example).");
  process.exit(1);
}

const BATCH = 6; // the embed function allows 8 per request (Edge Function CPU limit)
const corpus = process.env.KNOWLEDGE_CORPUS ?? "gst";
const prefix = corpus === "gst" ? "" : `${corpus}:`;
const chunks = (await readFile(process.env.KNOWLEDGE_CHUNKS ?? new URL("../../../knowledge/gst/chunks.jsonl", import.meta.url), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  // Builds from before search texts existed embedded the whole entry.
  .map((c) => ({ ...c, id: prefix + c.id, search: c.search ?? c.text }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function embed(texts, attempt = 1) {
  let response;
  try {
    response = await fetch(embedUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-embed-key": embedKey },
      body: JSON.stringify({ input: texts }),
    });
  } catch (error) {
    if (attempt >= 4) throw error;
    await sleep(1000 * attempt);
    return embed(texts, attempt + 1);
  }
  // 546 WORKER_LIMIT: the function ran out of CPU time. Split the batch and try again.
  if (response.status === 546 && texts.length > 1) {
    const half = Math.ceil(texts.length / 2);
    return [...(await embed(texts.slice(0, half))), ...(await embed(texts.slice(half)))];
  }
  // Cold starts and brief overloads: wait and retry a few times.
  if ((response.status >= 500 || response.status === 429) && attempt < 4) {
    await sleep(1000 * attempt);
    return embed(texts, attempt + 1);
  }
  if (!response.ok) throw new Error(`embed failed: ${response.status} ${await response.text()}`);
  return (await response.json()).embeddings;
}

const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

// What is already stored, so a re-run only embeds new or changed chunks.
const stored = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from("knowledge_chunks")
    .select("id, content, search_text")
    .eq("corpus", corpus)
    .not("embedding", "is", null)
    .range(from, from + 999);
  if (error) throw new Error(`read failed: ${error.message}`);
  for (const row of data) stored.set(row.id, `${row.search_text}\n${row.content}`);
  if (data.length < 1000) break;
}
const todo = chunks.filter((c) => stored.get(c.id) !== `${c.search}\n${c.text}`);
console.log(`${chunks.length} chunks, ${chunks.length - todo.length} already stored, ${todo.length} to embed`);

let done = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  // The search text is what gets embedded; the content is what the agent quotes.
  const vectors = await embed(batch.map((c) => c.search));
  const rows = batch.map((c, j) => ({
    id: c.id,
    corpus,
    kind: c.kind,
    hsn: c.hsn ?? null,
    description: c.description ?? null,
    gst: c.gst ?? null,
    content: c.text,
    search_text: c.search,
    sources: c.sources,
    embedding: JSON.stringify(vectors[j]),
    updated_at: new Date().toISOString(),
  }));
  // A dropped connection shouldn't end a 10-minute run: retry the write a few times.
  for (let attempt = 1; ; attempt++) {
    const { error } = await db
      .from("knowledge_chunks")
      .upsert(rows, { onConflict: "id" })
      .then(
        (result) => result,
        (thrown) => ({ error: thrown }),
      );
    if (!error) break;
    if (attempt >= 4) throw new Error(`upsert failed: ${error.message}`);
    await sleep(1000 * attempt);
  }
  done += batch.length;
  if (done % 60 === 0 || done === todo.length) console.log(`${done}/${todo.length} embedded`);
}

// Chunks that are no longer in the corpus (an entry omitted by a later notification).
const current = new Set(chunks.map((c) => c.id));
const stale = [...stored.keys()].filter((id) => !current.has(id));
if (stale.length) {
  const { error } = await db.from("knowledge_chunks").delete().in("id", stale);
  if (error) throw new Error(`delete failed: ${error.message}`);
  console.log(`removed ${stale.length} chunks no longer in the corpus`);
}
console.log("done");
