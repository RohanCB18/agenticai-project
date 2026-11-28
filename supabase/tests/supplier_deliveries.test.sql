-- Run with `npx supabase test db`. A wholesaler's delivery goes into stock once, marks the order
-- delivered, and only the server records it.
begin;
select plan(7);

create temporary table t as
  select m.id as merchant_id, p.id as rice_id, p.stock_qty as rice_before
    from public.merchants m
    join public.products p on p.merchant_id = m.id
   where m.owner_id = '11111111-1111-1111-1111-111111111111' and p.name ilike '%rice%'
   limit 1;
grant select on t to authenticated;

insert into public.supplier_orders (id, merchant_id, supplier, order_ref, quote_id, lines, total_paise)
select '99999999-9999-9999-9999-999999999999', merchant_id, 'Sharma Traders', 'ST-TEST0001', 'q.u.ote',
       '[{"item": "Sona Masoori Rice", "quantity": 25, "unit": "kg"}]', 130000
  from t;

select is(
  public.receive_supplier_order('99999999-9999-9999-9999-999999999999', (select merchant_id from t),
    jsonb_build_array(jsonb_build_object('productId', (select rice_id from t), 'name', 'Rice', 'quantity', 25, 'unit', 'kg')),
    'INV-TEST0001', '2026-11-28T05:30:00Z'),
  true, 'a delivery is recorded');
select is(
  public.receive_supplier_order('99999999-9999-9999-9999-999999999999', (select merchant_id from t),
    jsonb_build_array(jsonb_build_object('productId', (select rice_id from t), 'name', 'Rice', 'quantity', 25, 'unit', 'kg')),
    'INV-TEST0001', '2026-11-28T05:30:00Z'),
  false, 'the same delivery again changes nothing');
select is((select stock_qty from public.products where id = (select rice_id from t)), (select rice_before + 25 from t), 'its goods come into stock once');
select is(
  (select count(*)::int from public.stock_movements where product_id = (select rice_id from t) and source = 'supplier' and reason = 'purchase' and delta = 25 and created_at = now()),
  1, 'as a purchase from the supplier');
select is(
  (select status || ' ' || invoice_no || ' ' || jsonb_array_length(received) from public.supplier_orders where id = '99999999-9999-9999-9999-999999999999'),
  'delivered INV-TEST0001 1', 'the order is delivered, with the invoice and what came');

-- As the owner: reading the order is fine; recording a delivery is the server's.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select status from public.supplier_orders where id = '99999999-9999-9999-9999-999999999999'), 'delivered', 'owners see their deliveries');
select throws_ok(
  $$ select public.receive_supplier_order('99999999-9999-9999-9999-999999999999', (select merchant_id from t), '[]', 'X', now()) $$,
  '42501', null, 'owners cannot record a delivery themselves');

select * from finish();
rollback;
