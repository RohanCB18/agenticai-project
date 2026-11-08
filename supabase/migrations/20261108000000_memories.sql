-- Things the owner asks Munshi to remember: about the shop ("call me Akka") or about a
-- customer ("Ramesh is Lakshmi's husband"). Habits like a usual payment day are not stored
-- here; they are worked out from the ledger each time, so they can't drift from the truth.
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete cascade, -- null for a shop-wide fact
  fact text not null check (char_length(fact) between 1 and 300),
  source public.entry_source not null,
  created_at timestamptz not null default now()
);
create index memories_merchant_idx on public.memories (merchant_id, customer_id, created_at desc);

alter table public.memories enable row level security;
create policy "owner reads memories" on public.memories
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner adds memories" on public.memories
  for insert to authenticated with check (public.owns_merchant(merchant_id));
create policy "owner forgets memories" on public.memories
  for delete to authenticated using (public.owns_merchant(merchant_id));
