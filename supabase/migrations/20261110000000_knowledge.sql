-- Reference knowledge Munshi answers from (GST rates and exemptions for now), searched by
-- meaning (pgvector, gte-small embeddings from the `embed` Edge Function) and by keywords
-- (full-text), combined with reciprocal rank fusion. Every row carries the official source it
-- came from, so answers can cite the notification, its serial number and its date.

create table public.knowledge_chunks (
  id text primary key,
  corpus text not null default 'gst',
  kind text not null,               -- rate | exempt | list | definition
  hsn text,
  description text,
  gst numeric(6, 3),                -- total GST a customer pays (CGST + SGST, or IGST); null for definitions
  content text not null,            -- the entry as the model quotes it: rate, schedule, S. No., notification
  -- What is embedded and keyword-indexed: the goods description in plain words, without the
  -- rate and notification sentence every entry shares (it blurred the embeddings).
  search_text text not null,
  sources jsonb not null,           -- [{ id, title, gsr, dated, effectiveFrom, url }]
  embedding extensions.vector(384), -- gte-small, of search_text
  fts tsvector generated always as (
    to_tsvector('english', search_text || ' ' || coalesce(hsn, ''))
  ) stored,
  updated_at timestamptz not null default now()
);

create index knowledge_chunks_embedding_idx on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index knowledge_chunks_fts_idx on public.knowledge_chunks using gin (fts);
create index knowledge_chunks_corpus_idx on public.knowledge_chunks (corpus);

-- Public reference data: any signed-in owner may read it; only the server (secret key) writes.
alter table public.knowledge_chunks enable row level security;
create policy "signed-in users read knowledge" on public.knowledge_chunks
  for select to authenticated using (true);

-- Hybrid search: the best `match_count` rows by reciprocal rank fusion of three rankings:
--   meaning   pgvector cosine distance to the query's gte-small embedding;
--   keywords  full-text match on any word of the query (OR), so "instant noodles" finds "noodles".
--             Words every entry contains (hsn, gst, rate...) are left out: they only add noise;
--   HSN code  an HSN code in the query ("HSN 2202 10", read off a bill) matched against each
--             entry's codes: the same code first, then the heading it falls under, then the
--             narrower codes under it. Neither embeddings nor full-text handle codes well.
-- The default weights were picked on the dev questions of apps/web/scripts/eval-knowledge.mjs. On
-- its held-out questions the answer is in the top 5 for 38 of 39 (MRR 0.815).
create function public.match_knowledge(
  query_embedding extensions.vector(384),
  query_text text,
  match_count int default 6,
  corpus_name text default 'gst',
  semantic_weight double precision default 1,
  keyword_weight double precision default 0.25,
  hsn_weight double precision default 2
)
returns table (id text, kind text, hsn text, description text, gst numeric, content text, sources jsonb, similarity double precision, score double precision)
language sql stable
set search_path = public, extensions
as $$
  with semantic as (
    select k.id, 1 - (k.embedding <=> query_embedding) as similarity,
           row_number() over (order by k.embedding <=> query_embedding) as r
    from knowledge_chunks k
    where k.corpus = corpus_name and k.embedding is not null
    order by k.embedding <=> query_embedding
    limit greatest(match_count, 1) * 4
  ),
  terms as (
    select to_tsquery('english', string_agg(quote_literal(word) || ':*', ' | ')) as q
    from regexp_split_to_table(lower(query_text), '[^a-z0-9]+') as word
    where length(word) > 2
      and word !~ '^[0-9]+$'
      and word not in ('hsn', 'gst', 'cgst', 'sgst', 'igst', 'rate', 'rates', 'tax', 'taxes', 'percent')
  ),
  keyword as (
    select k.id, row_number() over (order by ts_rank_cd(k.fts, t.q) desc) as r
    from knowledge_chunks k, terms t
    where k.corpus = corpus_name and t.q is not null and k.fts @@ t.q
    order by ts_rank_cd(k.fts, t.q) desc
    limit greatest(match_count, 1) * 4
  ),
  -- "2202 10", "22021010" or "2402" in the query, without spaces.
  query_codes as (
    select distinct regexp_replace(m[1], '\s', '', 'g') as code
    from regexp_matches(query_text, '(?<![0-9])([0-9]{4}(?:\s?[0-9]{2}){0,2})(?![0-9])', 'g') as m
  ),
  entry_codes as (
    select k.id, regexp_replace(c, '\s', '', 'g') as code
    from knowledge_chunks k, regexp_split_to_table(coalesce(k.hsn, ''), ',') as c
    where k.corpus = corpus_name and k.hsn is not null
  ),
  hsn_matches as (
    select e.id,
           row_number() over (order by min(case
             when e.code = q.code then 0                                         -- the same code
             when q.code like e.code || '%' then 10 + length(q.code) - length(e.code) -- the heading it falls under
             else 20 + length(e.code) - length(q.code)                           -- narrower codes under it
           end), e.id) as r
    from entry_codes e
    join query_codes q on e.code like q.code || '%' or q.code like e.code || '%'
    where length(e.code) >= 4
    group by e.id
    limit greatest(match_count, 1) * 4
  ),
  fused as (
    select coalesce(s.id, w.id) as id, s.similarity, s.r as s_r, w.r as w_r
    from semantic s
    full outer join keyword w on w.id = s.id
  )
  select k.id, k.kind, k.hsn, k.description, k.gst, k.content, k.sources,
         coalesce(f.similarity, 0) as similarity,
         semantic_weight * coalesce(1.0 / (60 + f.s_r), 0)
           + keyword_weight * coalesce(1.0 / (60 + f.w_r), 0)
           + hsn_weight * coalesce(1.0 / (60 + h.r), 0) as score
  from fused f
  full outer join hsn_matches h on h.id = f.id
  join knowledge_chunks k on k.id = coalesce(f.id, h.id)
  order by score desc
  limit match_count;
$$;
