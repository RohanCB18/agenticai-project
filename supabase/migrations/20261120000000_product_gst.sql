-- Each product's HSN code and GST rate: the base for GST invoices. The rate is always copied from
-- an official rate entry (gst_citation says which), found by code, never typed in or recalled.
alter table public.products
  add column hsn text check (hsn is null or hsn ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  add column gst_rate numeric(5, 2) check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 40)),
  add column gst_citation text;

-- apply_bill, as before, now also tagging products: a bill line's HSN code, and the official rate
-- when the bill check found exactly one for that code ('gst_official'), go to a product that has
-- no HSN code yet. A tag already set (by the owner or an earlier bill) is never overwritten.
create or replace function public.apply_bill(p_bill_id uuid, p_merchant_id uuid)
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

    if coalesce(v_item ->> 'hsn', '') ~ '^[0-9]{4}([0-9]{2}){0,2}$' then
      update public.products
         set hsn = v_item ->> 'hsn',
             gst_rate = (v_item ->> 'gst_official')::numeric,
             gst_citation = case when v_item ->> 'gst_official' is null then null else v_item ->> 'gst_citation' end
       where id = v_product and hsn is null;
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
