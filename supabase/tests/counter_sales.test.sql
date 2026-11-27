-- Run with `npx supabase test db`. A counter bill takes its goods out of stock and records the sale
-- once, only by the server; udhaar bills go on the customer's khata; owners read only their own bills.
begin;
select plan(10);

-- As the server: a cash bill for 1.5 kg of rice, and an udhaar bill for Ramesh.
create temporary table t as
  select m.id as merchant_id, p.id as rice_id, p.stock_qty as rice_before, c.id as ramesh_id
    from public.merchants m
    join public.products p on p.merchant_id = m.id
    join public.customers c on c.merchant_id = m.id
   where m.owner_id = '11111111-1111-1111-1111-111111111111' and p.name ilike '%rice%' and c.name ilike 'ramesh%'
   limit 1;
grant select on t to authenticated;

insert into public.counter_sales (id, merchant_id, method, items, total_paise)
select '66666666-6666-6666-6666-666666666666', merchant_id, 'cash',
       jsonb_build_array(jsonb_build_object('productId', rice_id, 'name', 'Rice', 'unit', 'kg', 'quantity', 1.5, 'pricePaise', 6000, 'amountPaise', 9000)),
       9000
  from t;

select is(public.settle_counter_sale('66666666-6666-6666-6666-666666666666', (select merchant_id from t)), true, 'a bill is recorded');
select is(public.settle_counter_sale('66666666-6666-6666-6666-666666666666', (select merchant_id from t)), false, 'the same bill again changes nothing');
select is((select stock_qty from public.products where id = (select rice_id from t)), (select rice_before - 1.5 from t), 'its goods leave the stock once');
select is(
  (select count(*)::int from public.ledger_entries where kind = 'sale' and source = 'counter' and amount_paise = 9000 and note = 'Counter: Rice 1.5 kg'),
  1, 'one sale entry with what was sold');
select is((select status::text from public.counter_sales where id = '66666666-6666-6666-6666-666666666666'), 'paid', 'the bill is paid');

insert into public.counter_sales (id, merchant_id, method, customer_id, items, total_paise)
select '77777777-7777-7777-7777-777777777777', merchant_id, 'udhaar', ramesh_id,
       jsonb_build_array(jsonb_build_object('productId', rice_id, 'name', 'Rice', 'unit', 'kg', 'quantity', 2, 'pricePaise', 6000, 'amountPaise', 12000)),
       12000
  from t;
select is(public.settle_counter_sale('77777777-7777-7777-7777-777777777777', (select merchant_id from t)), true, 'an udhaar bill is recorded');
select is(
  (select count(*)::int from public.ledger_entries where kind = 'credit_given' and customer_id = (select ramesh_id from t) and amount_paise = 12000 and source = 'counter'),
  1, 'it goes on the customer''s khata as udhaar');
select throws_ok(
  $$ insert into public.counter_sales (merchant_id, method, items, total_paise)
     values ((select merchant_id from t), 'udhaar', '[{"productId":"x"}]', 100) $$,
  '23514', null, 'an udhaar bill needs a customer');

-- As the owner: reading is fine; writing or settling a bill is not.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is(
  (select count(*)::int from public.counter_sales where id in ('66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777')),
  2, 'owners see their own bills');
select throws_ok(
  $$ select public.settle_counter_sale('66666666-6666-6666-6666-666666666666', (select merchant_id from t)) $$,
  '42501', null, 'owners cannot record a bill themselves');

select * from finish();
rollback;
