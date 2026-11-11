// Text embeddings for Munshi's knowledge search, with gte-small (384 dimensions) running inside
// Supabase: no third-party embedding API. Called by the app's server and the ingest script with a
// shared key (EMBED_KEY, set with `supabase secrets set`), since it is deployed without JWT checks.
//
// POST { "input": "text" | ["text", ...] }  ->  { "embeddings": number[][] }

const model = new Supabase.ai.Session("gte-small");
// Edge Functions have a per-request CPU limit: 16 texts hit it in testing, 8 took about 2 s.
const MAX_INPUTS = 8;
const MAX_CHARS = 4000;

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const key = Deno.env.get("EMBED_KEY");
  if (!key || request.headers.get("x-embed-key") !== key) return new Response("Unauthorized", { status: 401 });

  let input: unknown;
  try {
    ({ input } = await request.json());
  } catch {
    return new Response("Body must be JSON", { status: 400 });
  }
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0 || texts.length > MAX_INPUTS || texts.some((t) => typeof t !== "string" || !t.trim() || t.length > MAX_CHARS)) {
    return new Response(`input must be 1-${MAX_INPUTS} non-empty strings of up to ${MAX_CHARS} characters`, { status: 400 });
  }

  const embeddings: number[][] = [];
  for (const text of texts as string[]) {
    const vector = (await model.run(text, { mean_pool: true, normalize: true })) as number[];
    embeddings.push(Array.from(vector));
  }
  return Response.json({ embeddings });
});
