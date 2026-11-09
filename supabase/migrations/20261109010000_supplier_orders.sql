-- Orders placed with a wholesaler's agent over A2A, after the owner approved the quote.
-- The wholesaler's order id is unique per shop, so an order saved twice is kept once.
create table public.supplier_orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  supplier text not null,
  order_ref text not null,
  quote_id text not null,
  lines jsonb not null,
  total_paise bigint not null check (total_paise > 0),
  delivery_slot text,
  payment text,
  status text not null default 'confirmed' check (status in ('confirmed', 'delivered', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (merchant_id, supplier, order_ref)
);
create index supplier_orders_merchant_idx on public.supplier_orders (merchant_id, created_at desc);

alter table public.supplier_orders enable row level security;
create policy "owner reads own supplier orders" on public.supplier_orders
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner records own supplier orders" on public.supplier_orders
  for insert to authenticated with check (public.owns_merchant(merchant_id));
