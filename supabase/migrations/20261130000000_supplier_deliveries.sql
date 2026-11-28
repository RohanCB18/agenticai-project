-- Deliveries from a wholesaler, received without the owner. When the van reaches the shop, the
-- wholesaler's agent sends its delivery note (the invoice, as data), and Munshi adds each line to
-- the matching product's stock. Before this, stock came in only from a photo of the supplier's bill.

alter type public.entry_source add value if not exists 'supplier';

-- What came, by the delivery note: [{productId, name, quantity, unit}], the lines placed on the
-- shop's products. invoice_no is the wholesaler's.
alter table public.supplier_orders
  add column delivered_at timestamptz,
  add column invoice_no text check (invoice_no is null or char_length(invoice_no) <= 60),
  add column received jsonb check (received is null or jsonb_typeof(received) = 'array');

-- Records a delivery once: every line into stock and the order marked delivered, in one
-- transaction. True when this call recorded it; false when it was already delivered or cancelled,
-- so a delivery note reported twice changes the stock once.
create or replace function public.receive_supplier_order(
  p_order_id uuid,
  p_merchant_id uuid,
  p_items jsonb,
  p_invoice text,
  p_delivered_at timestamptz
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  perform 1 from public.supplier_orders
   where id = p_order_id and merchant_id = p_merchant_id and status = 'confirmed'
     for update;
  if not found then
    return false;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((v_item ->> 'quantity')::numeric, 0) > 0
       and exists (select 1 from public.products where id = (v_item ->> 'productId')::uuid and merchant_id = p_merchant_id) then
      insert into public.stock_movements (merchant_id, product_id, delta, reason, source)
      values (p_merchant_id, (v_item ->> 'productId')::uuid, (v_item ->> 'quantity')::numeric, 'purchase', 'supplier');
    end if;
  end loop;

  update public.supplier_orders
     set status = 'delivered', delivered_at = coalesce(p_delivered_at, now()), invoice_no = left(p_invoice, 60), received = coalesce(p_items, '[]'::jsonb)
   where id = p_order_id;
  return true;
end;
$$;

revoke execute on function public.receive_supplier_order(uuid, uuid, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.receive_supplier_order(uuid, uuid, jsonb, text, timestamptz) to service_role;
