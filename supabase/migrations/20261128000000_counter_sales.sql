-- Counter billing: the bill made at the till is what takes goods out of stock, as at a
-- supermarket's checkout, so the owner never tells Munshi what sold. Stock comes in from supplier
-- bills (apply_bill); it goes out here, item by item, the moment a bill is paid; and a product at
-- its alert level gets a restock ask on the owner's chat app.

alter type public.entry_source add value if not exists 'counter';

-- The code printed on packaged goods (EAN-13 on Parle G, Maggi...), linked to a product the first
-- time the owner scans it. One product per code in a shop.
alter table public.products add column barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,32}$');
create unique index products_barcode_idx on public.products (merchant_id, barcode) where barcode is not null;

create type public.counter_sale_status as enum ('open', 'paid', 'cancelled');
create type public.counter_pay_method as enum ('upi', 'cash', 'udhaar');

-- One bill at the counter. items: [{productId, name, unit, quantity, pricePaise, amountPaise}],
-- copied from the products when the bill was made. A UPI bill stays open until Cashfree says it
-- was paid; cash and udhaar bills are paid when made.
create table public.counter_sales (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  status public.counter_sale_status not null default 'open',
  method public.counter_pay_method not null,
  customer_id uuid references public.customers (id) on delete set null,
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  total_paise bigint not null check (total_paise > 0),
  cashfree_link_id text unique,
  payment_url text,
  ledger_entry_id uuid references public.ledger_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint udhaar_bill_needs_customer check (method <> 'udhaar' or customer_id is not null)
);
create index counter_sales_merchant_idx on public.counter_sales (merchant_id, created_at desc);

-- Owners read their bills; only the server writes them (it checks the payment first).
alter table public.counter_sales enable row level security;
create policy "owner reads counter sales" on public.counter_sales
  for select to authenticated using (public.owns_merchant(merchant_id));

-- Records a bill as paid, once: one ledger entry (a sale, or udhaar for the customer) and one
-- stock movement out per item, in one transaction. True when this call recorded it; false when
-- it was already paid or cancelled, so a webhook and a status check reporting the same payment
-- change the books once.
create or replace function public.settle_counter_sale(p_sale_id uuid, p_merchant_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_sale public.counter_sales;
  v_item jsonb;
  v_entry uuid;
  v_note text;
begin
  select * into v_sale from public.counter_sales
   where id = p_sale_id and merchant_id = p_merchant_id and status = 'open'
     for update;
  if not found then
    return false;
  end if;

  select string_agg(format('%s %s %s', i ->> 'name', trim_scale((i ->> 'quantity')::numeric), i ->> 'unit'), ', ')
    into v_note
    from jsonb_array_elements(v_sale.items) i;

  insert into public.ledger_entries (merchant_id, customer_id, kind, amount_paise, note, source)
  values (
    p_merchant_id,
    case when v_sale.method = 'udhaar' then v_sale.customer_id end,
    (case when v_sale.method = 'udhaar' then 'credit_given' else 'sale' end)::public.ledger_kind,
    v_sale.total_paise,
    left('Counter: ' || coalesce(v_note, ''), 500),
    'counter'
  )
  returning id into v_entry;

  for v_item in select * from jsonb_array_elements(v_sale.items) loop
    if coalesce((v_item ->> 'quantity')::numeric, 0) > 0
       and exists (select 1 from public.products where id = (v_item ->> 'productId')::uuid and merchant_id = p_merchant_id) then
      insert into public.stock_movements (merchant_id, product_id, delta, reason, source)
      values (p_merchant_id, (v_item ->> 'productId')::uuid, -((v_item ->> 'quantity')::numeric), 'sale', 'counter');
    end if;
  end loop;

  update public.counter_sales
     set status = 'paid', paid_at = now(), ledger_entry_id = v_entry
   where id = p_sale_id;
  return true;
end;
$$;

revoke execute on function public.settle_counter_sale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.settle_counter_sale(uuid, uuid) to service_role;
