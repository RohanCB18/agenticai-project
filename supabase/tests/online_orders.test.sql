-- Run with `npx supabase test db`. An online order takes its goods out of stock exactly like a
-- counter bill, once, and says it was online; it needs a buyer, can't be udhaar, and nobody but
-- the server (and the owner, reading) sees it.
begin;
select plan(9);

create temporary table t as
  select m.id as merchant_id, p.id as rice_id, p.stock_qty as rice_before
    from public.merchants m
    join public.products p on p.merchant_id = m.id
   where m.owner_id = '11111111-1111-1111-1111-111111111111' and p.name ilike '%rice%'
   limit 1;
grant select on t to authenticated, anon;

insert into public.counter_sales (id, merchant_id, channel, method, items, total_paise, buyer_name, buyer_phone, buyer_address)
select '88888888-8888-8888-8888-888888888888', merchant_id, 'online', 'upi',
       jsonb_build_array(jsonb_build_object('productId', rice_id, 'name', 'Rice', 'unit', 'kg', 'quantity', 2, 'pricePaise', 6200, 'amountPaise', 12400)),
       12400, 'Priya', '9845012345', '12, 4th Cross'
  from t;

select is(public.settle_counter_sale('88888888-8888-8888-8888-888888888888', (select merchant_id from t)), true, 'an online order is recorded when paid');
select is(public.settle_counter_sale('88888888-8888-8888-8888-888888888888', (select merchant_id from t)), false, 'and only once');
select is((select stock_qty from public.products where id = (select rice_id from t)), (select rice_before - 2 from t), 'its goods leave the stock once');
select is(
  (select count(*)::int from public.ledger_entries where kind = 'sale' and source = 'online' and amount_paise = 12400 and note = 'Online order (Priya): Rice 2 kg'),
  1, 'the sale says it was an online order, and whose');
select is(
  (select count(*)::int from public.stock_movements where product_id = (select rice_id from t) and source = 'online' and delta = -2),
  1, 'the stock movement says online too');

select throws_ok(
  $$ insert into public.counter_sales (merchant_id, channel, method, items, total_paise)
     values ((select merchant_id from t), 'online', 'cash', '[{"productId":"x"}]', 100) $$,
  '23514', null, 'an online order needs a buyer');
select throws_ok(
  $$ insert into public.counter_sales (merchant_id, channel, method, customer_id, items, total_paise, buyer_name, buyer_phone)
     values ((select merchant_id from t), 'online', 'udhaar', (select id from public.customers limit 1), '[{"productId":"x"}]', 100, 'Priya', '9845012345') $$,
  '23514', null, 'an online order is never udhaar');

-- Customers aren't signed in: they never read orders directly (the server shows them theirs).
set local role anon;
select is((select count(*)::int from public.counter_sales), 0, 'anonymous visitors see no orders');
reset role;

select throws_ok(
  $$ update public.merchants set shop_slug = 'Not A Slug!' where id = (select merchant_id from t) $$,
  '23514', null, 'a store address is lowercase words and dashes');

select * from finish();
rollback;
