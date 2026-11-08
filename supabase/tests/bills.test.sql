-- Run with `npx supabase test db`. A bill changes stock once, only after approval, and only by the server.
begin;
select plan(9);

-- As the server: a pending bill with one known product and one new item.
create temporary table t as
  select m.id as merchant_id, p.id as rice_id, p.stock_qty as rice_before
    from public.merchants m
    join public.products p on p.merchant_id = m.id
   where m.owner_id = '11111111-1111-1111-1111-111111111111' and p.name ilike '%rice%'
   limit 1;
grant select on t to authenticated;

insert into public.bills (id, merchant_id, supplier_name, bill_number, total_paise, items, source)
select '44444444-4444-4444-4444-444444444444', merchant_id, 'Ganesh Traders', '88', 200000,
       jsonb_build_array(
         jsonb_build_object('name', 'Sona Masoori Rice', 'quantity', 25, 'unit', 'kg', 'product_id', rice_id),
         jsonb_build_object('name', 'Sunflower Oil', 'quantity', 6, 'unit', 'ltr', 'product_id', null)),
       'telegram'
  from t;

select is(public.apply_bill('44444444-4444-4444-4444-444444444444', (select merchant_id from t)), 1, 'applying creates the one new product');
select is((select stock_qty from public.products where id = (select rice_id from t)), (select rice_before + 25 from t), 'known product gains the billed quantity');
select is((select stock_qty from public.products where name = 'Sunflower Oil'), 6::numeric, 'new product starts with the billed quantity');
select is((select count(*)::int from public.suppliers where name = 'Ganesh Traders'), 1, 'a new supplier is created');
select is((select status::text from public.bills where id = '44444444-4444-4444-4444-444444444444'), 'applied', 'bill is marked applied');

select is(public.apply_bill('44444444-4444-4444-4444-444444444444', (select merchant_id from t)), -1, 'a second tap does nothing');
select is((select stock_qty from public.products where id = (select rice_id from t)), (select rice_before + 25 from t), 'stock is added only once');

-- As an owner: reading is fine, applying or forging is not.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select throws_ok(
  $$ select public.apply_bill('44444444-4444-4444-4444-444444444444', (select merchant_id from t)) $$,
  '42501', null, 'owners cannot call apply_bill directly');
select throws_ok(
  $$ insert into public.bills (merchant_id, items, source) values ((select merchant_id from t), '[]', 'chat') $$,
  '42501', null, 'owners cannot forge a bill');

select * from finish();
rollback;
