-- In-shop UPI QRs: an exact-amount QR the owner shows a customer at the counter. Unlike a
-- plain shop QR, each one is tied to a customer, so a payment lands on the right khata.
create table public.payment_qrs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  cashfree_order_id text not null unique,
  amount_paise bigint not null check (amount_paise > 0),
  amount_paid_paise bigint not null default 0,
  status public.payment_link_status not null default 'active',
  -- The QR image (base64 PNG). Cashfree returns it once, when the QR is created.
  qr_png text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_qrs_merchant_idx on public.payment_qrs (merchant_id, created_at desc);

-- Like payment links: owners can read theirs, only the server writes.
alter table public.payment_qrs enable row level security;
create policy "owner reads payment qrs" on public.payment_qrs
  for select to authenticated using (public.owns_merchant(merchant_id));
