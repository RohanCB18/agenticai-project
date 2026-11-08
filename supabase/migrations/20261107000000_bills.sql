-- Supplier bills read from photos. A bill waits as 'pending' until the owner approves it, and
-- only then touches stock. Its text is untrusted, so it never reaches the agent's prompt.
create type public.bill_status as enum ('pending', 'applied', 'rejected');

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  supplier_id uuid references public.suppliers (id) on delete set null,
  supplier_name text,
  bill_number text,
  bill_date text, -- as written on the bill; formats vary too much to parse safely
  total_paise bigint check (total_paise is null or total_paise >= 0),
  -- [{ name, quantity, unit, rate, amount, product_id }], product_id null for a new item.
  items jsonb not null,
  warnings text[] not null default '{}',
  status public.bill_status not null default 'pending',
  source public.entry_source not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index bills_merchant_idx on public.bills (merchant_id, created_at desc);

-- Owners can read their bills; only the server writes.
alter table public.bills enable row level security;
create policy "owner reads bills" on public.bills
  for select to authenticated using (public.owns_merchant(merchant_id));

-- Applies a pending bill in one transaction, so a double tap or a crash halfway can't add
-- stock twice or leave a bill half applied. Returns the number of new products created,
-- or -1 if the bill is not pending.
create function public.apply_bill(p_bill_id uuid, p_merchant_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_bill public.bills;
  v_item jsonb;
  v_product uuid;
  v_supplier uuid;
  v_new integer := 0;
begin
  select * into v_bill from public.bills
   where id = p_bill_id and merchant_id = p_merchant_id and status = 'pending'
     for update;
  if not found then
    return -1;
  end if;

  if v_bill.supplier_name is not null then
    select id into v_supplier from public.suppliers
     where merchant_id = p_merchant_id and lower(name) = lower(v_bill.supplier_name)
     limit 1;
    if v_supplier is null then
      insert into public.suppliers (merchant_id, name)
      values (p_merchant_id, v_bill.supplier_name)
      returning id into v_supplier;
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(v_bill.items) loop
    select id into v_product from public.products
     where merchant_id = p_merchant_id and id = nullif(v_item ->> 'product_id', '')::uuid;
    if v_product is null then
      insert into public.products (merchant_id, name, unit, supplier_id)
      values (p_merchant_id, v_item ->> 'name', coalesce(nullif(v_item ->> 'unit', ''), 'pcs'), v_supplier)
      returning id into v_product;
      v_new := v_new + 1;
    end if;

    if coalesce((v_item ->> 'quantity')::numeric, 0) > 0 then
      insert into public.stock_movements (merchant_id, product_id, delta, reason, source)
      values (p_merchant_id, v_product, (v_item ->> 'quantity')::numeric, 'purchase', v_bill.source);
    end if;
  end loop;

  update public.bills
     set status = 'applied', decided_at = now(), supplier_id = v_supplier
   where id = p_bill_id;

  insert into public.audit_log (merchant_id, actor, action, details)
  values (p_merchant_id, 'owner', 'bill_applied', jsonb_build_object('billId', p_bill_id, 'newProducts', v_new));

  return v_new;
end;
$$;

revoke execute on function public.apply_bill(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_bill(uuid, uuid) to service_role;
