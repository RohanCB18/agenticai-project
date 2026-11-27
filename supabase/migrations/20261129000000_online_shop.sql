-- The shop's own online store: customers order from their phones, and the order takes goods out of
-- stock exactly as a bill at the counter does. In a supermarket that is the billing counter; for a
-- demo it is the same thing without the till. Online orders are counter_sales rows with channel
-- 'online', recorded by the same settle_counter_sale, so there is one stock count however goods leave.

alter type public.entry_source add value if not exists 'online';

-- The store's address, /shop/<shop_slug>, and whether it takes orders. Closed until the owner opens it.
alter table public.merchants
  add column shop_slug text unique check (shop_slug is null or (shop_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(shop_slug) <= 60)),
  add column shop_open boolean not null default false;

create type public.sale_channel as enum ('counter', 'online');

-- Who ordered online, and where to deliver. Counter bills have none of this.
alter table public.counter_sales
  add column channel public.sale_channel not null default 'counter',
  add column buyer_name text check (buyer_name is null or char_length(buyer_name) between 1 and 80),
  add column buyer_phone text check (buyer_phone is null or buyer_phone ~ '^[6-9][0-9]{9}$'),
  add column buyer_address text check (buyer_address is null or char_length(buyer_address) <= 300),
  add constraint online_order_has_buyer check (channel <> 'online' or (buyer_name is not null and buyer_phone is not null)),
  add constraint online_order_not_udhaar check (channel <> 'online' or method <> 'udhaar');
create index counter_sales_online_idx on public.counter_sales (merchant_id, created_at desc) where channel = 'online';

-- As before, plus: an online order's ledger entry says so, with the buyer's name.
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
  v_online boolean;
begin
  select * into v_sale from public.counter_sales
   where id = p_sale_id and merchant_id = p_merchant_id and status = 'open'
     for update;
  if not found then
    return false;
  end if;
  v_online := v_sale.channel = 'online';

  select string_agg(format('%s %s %s', i ->> 'name', trim_scale((i ->> 'quantity')::numeric), i ->> 'unit'), ', ')
    into v_note
    from jsonb_array_elements(v_sale.items) i;

  insert into public.ledger_entries (merchant_id, customer_id, kind, amount_paise, note, source)
  values (
    p_merchant_id,
    case when v_sale.method = 'udhaar' then v_sale.customer_id end,
    (case when v_sale.method = 'udhaar' then 'credit_given' else 'sale' end)::public.ledger_kind,
    v_sale.total_paise,
    left(case when v_online then 'Online order (' || v_sale.buyer_name || '): ' else 'Counter: ' end || coalesce(v_note, ''), 500),
    (case when v_online then 'online' else 'counter' end)::public.entry_source
  )
  returning id into v_entry;

  for v_item in select * from jsonb_array_elements(v_sale.items) loop
    if coalesce((v_item ->> 'quantity')::numeric, 0) > 0
       and exists (select 1 from public.products where id = (v_item ->> 'productId')::uuid and merchant_id = p_merchant_id) then
      insert into public.stock_movements (merchant_id, product_id, delta, reason, source)
      values (
        p_merchant_id, (v_item ->> 'productId')::uuid, -((v_item ->> 'quantity')::numeric), 'sale',
        (case when v_online then 'online' else 'counter' end)::public.entry_source
      );
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
