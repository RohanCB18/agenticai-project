-- Charts Munshi drew for an owner (a PNG made in a sandbox from the shop's own numbers), kept so
-- the chat can show them: sent as a photo on Telegram, loaded from /api/charts/<id> in the web chat.
create table public.charts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  png_base64 text not null,
  created_at timestamptz not null default now()
);
create index charts_merchant_idx on public.charts (merchant_id, created_at desc);

-- Owners read their own charts; only the server writes them.
alter table public.charts enable row level security;
create policy "owner reads own charts" on public.charts
  for select to authenticated using (public.owns_merchant(merchant_id));
