-- Munshi core schema: merchants, customers, ledger (udhaar), inventory, suppliers,
-- payment links, human approvals and an append-only audit log.
-- Money is always integer paise (bigint). Every table is merchant-scoped and RLS-protected.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- enums
create type public.language_code as enum ('kn', 'hi', 'ta', 'bn', 'en');
create type public.ledger_kind as enum ('credit_given', 'payment_received', 'sale', 'expense', 'supplier_payment');
create type public.entry_source as enum ('voice', 'chat', 'whatsapp', 'webhook', 'system');
create type public.approval_action as enum ('payment_link', 'supplier_payout', 'purchase_order', 'reminder_campaign');
create type public.approval_status as enum ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed');
create type public.payment_link_status as enum ('created', 'active', 'paid', 'partially_paid', 'expired', 'cancelled');

-- ---------------------------------------------------------------- merchants
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  shop_name text not null check (char_length(shop_name) between 1 and 120),
  owner_name text,
  phone text,
  gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
  preferred_language public.language_code not null default 'hi',
  -- Guardrail: the agent can never move more than this per day without a fresh limit change.
  daily_payout_limit_paise bigint not null default 2500000 check (daily_payout_limit_paise >= 0),
  created_at timestamptz not null default now()
);

-- Ownership check used by every RLS policy. SECURITY DEFINER so it can read merchants
-- without recursing into merchants' own policy; search_path pinned against hijacking.
create function public.owns_merchant(m uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.merchants
    where id = m and owner_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------- customers
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  -- Spoken variants ("Ramesh bhaiya", "ರಮೇಶ್") so voice input resolves to the right person.
  aliases text[] not null default '{}',
  phone text,
  language public.language_code,
  notes text,
  created_at timestamptz not null default now()
);
create index customers_merchant_idx on public.customers (merchant_id);

-- ---------------------------------------------------------------- suppliers
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  name text not null,
  phone text,
  gstin text,
  -- Payouts only ever go to a beneficiary the merchant verified; the agent cannot add one.
  cashfree_beneficiary_id text,
  beneficiary_verified boolean not null default false,
  a2a_agent_card_url text,
  created_at timestamptz not null default now()
);
create index suppliers_merchant_idx on public.suppliers (merchant_id);

-- ---------------------------------------------------------------- inventory
create table public.products (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  unit text not null default 'pcs', -- pcs, kg, litre, packet, crate
  stock_qty numeric(12, 3) not null default 0,
  reorder_level numeric(12, 3),
  price_paise bigint check (price_paise is null or price_paise >= 0),
  supplier_id uuid references public.suppliers (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index products_merchant_idx on public.products (merchant_id);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  delta numeric(12, 3) not null check (delta <> 0),
  reason text not null, -- sale, purchase, wastage, correction
  source public.entry_source not null,
  created_at timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at desc);

-- Keep products.stock_qty in step with the movement log.
create function public.apply_stock_movement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.products
     set stock_qty = stock_qty + new.delta, updated_at = now()
   where id = new.product_id and merchant_id = new.merchant_id;
  return new;
end;
$$;
create trigger stock_movements_apply
after insert on public.stock_movements
for each row execute function public.apply_stock_movement();

-- ---------------------------------------------------------------- ledger
create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  supplier_id uuid references public.suppliers (id) on delete set null,
  kind public.ledger_kind not null,
  amount_paise bigint not null check (amount_paise > 0),
  note text,
  source public.entry_source not null,
  -- The agent trace that wrote this row, for the audit trail in Langfuse.
  trace_id text,
  created_at timestamptz not null default now(),
  constraint udhaar_needs_customer check (
    kind not in ('credit_given', 'payment_received') or customer_id is not null
  )
);
create index ledger_merchant_time_idx on public.ledger_entries (merchant_id, created_at desc);
create index ledger_customer_idx on public.ledger_entries (customer_id);

-- Outstanding udhaar per customer. security_invoker so callers' RLS still applies.
create view public.customer_balances
with (security_invoker = true)
as
select
  c.merchant_id,
  c.id as customer_id,
  c.name,
  coalesce(sum(case l.kind when 'credit_given' then l.amount_paise
                           when 'payment_received' then -l.amount_paise
                           else 0 end), 0)::bigint as outstanding_paise,
  max(l.created_at) filter (where l.kind = 'credit_given') as last_credit_at,
  max(l.created_at) filter (where l.kind = 'payment_received') as last_payment_at
from public.customers c
left join public.ledger_entries l on l.customer_id = c.id
group by c.merchant_id, c.id, c.name;

-- ---------------------------------------------------------------- approvals (human in the loop)
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  action public.approval_action not null,
  status public.approval_status not null default 'pending',
  -- Human-readable summary read aloud to the merchant, e.g. "₹12,000 Sharma Traders ko bhejna hai".
  summary text not null,
  payload jsonb not null,
  amount_paise bigint check (amount_paise is null or amount_paise > 0),
  requested_by text not null, -- agent name
  trace_id text,
  expires_at timestamptz not null default now() + interval '30 minutes',
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_pending_idx on public.approvals (merchant_id, created_at desc) where status = 'pending';

-- ---------------------------------------------------------------- payment links (Cashfree)
create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  approval_id uuid references public.approvals (id) on delete set null,
  cashfree_link_id text unique,
  link_url text,
  amount_paise bigint not null check (amount_paise > 0),
  amount_paid_paise bigint not null default 0,
  status public.payment_link_status not null default 'created',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_links_merchant_idx on public.payment_links (merchant_id, created_at desc);

-- ---------------------------------------------------------------- audit log (append-only)
create table public.audit_log (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  actor text not null, -- 'owner' or an agent name
  action text not null,
  details jsonb not null default '{}',
  trace_id text,
  created_at timestamptz not null default now()
);
create index audit_log_merchant_idx on public.audit_log (merchant_id, created_at desc);

-- ---------------------------------------------------------------- RLS
alter table public.merchants enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table public.products enable row level security;
alter table public.stock_movements enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.approvals enable row level security;
alter table public.payment_links enable row level security;
alter table public.audit_log enable row level security;

create policy "owner reads own merchant" on public.merchants
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "owner updates own merchant" on public.merchants
  for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Full CRUD for the merchant's own working data.
do $$
declare t text;
begin
  foreach t in array array['customers', 'suppliers', 'products', 'ledger_entries'] loop
    execute format(
      'create policy "owner manages %1$s" on public.%1$I for all to authenticated
         using (public.owns_merchant(merchant_id)) with check (public.owns_merchant(merchant_id))', t);
  end loop;
end $$;

-- Stock movements and audit entries are insert + read only: history is never edited.
create policy "owner reads stock movements" on public.stock_movements
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner inserts stock movements" on public.stock_movements
  for insert to authenticated with check (public.owns_merchant(merchant_id));
create policy "owner reads audit log" on public.audit_log
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner appends audit log" on public.audit_log
  for insert to authenticated with check (public.owns_merchant(merchant_id));

-- Approvals: agents (server, as the user) create them; the owner can only flip pending ones.
create policy "owner reads approvals" on public.approvals
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner creates approvals" on public.approvals
  for insert to authenticated with check (public.owns_merchant(merchant_id) and status = 'pending');
create policy "owner decides pending approvals" on public.approvals
  for update to authenticated
  using (public.owns_merchant(merchant_id) and status = 'pending')
  with check (public.owns_merchant(merchant_id) and status in ('approved', 'rejected'));

-- Payment links are written only by the server (service role) after Cashfree confirms.
create policy "owner reads payment links" on public.payment_links
  for select to authenticated using (public.owns_merchant(merchant_id));

-- ---------------------------------------------------------------- onboarding
-- Every new auth user gets a merchant row from their signup metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.merchants (owner_id, shop_name, owner_name, preferred_language)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'shop_name', ''), 'My Shop'),
    new.raw_user_meta_data ->> 'owner_name',
    coalesce((new.raw_user_meta_data ->> 'preferred_language')::public.language_code, 'hi')
  );
  return new;
end;
$$;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.apply_stock_movement() from public, anon, authenticated;
