-- Run with `npx supabase test db`. An approved bill tags products with HSN codes and official GST
-- rates, never overwrites a tag already set, and bad codes or rates can't be stored.
begin;
select plan(7);

create temporary table t as
  select m.id as merchant_id, p.id as rice_id
    from public.merchants m
    join public.products p on p.merchant_id = m.id
   where m.owner_id = '11111111-1111-1111-1111-111111111111' and p.name ilike '%rice%'
   limit 1;

-- Rice already carries the owner's tag; dal is new and its rate was clear; oil's rate wasn't.
update public.products set hsn = '1006', gst_rate = 5, gst_citation = 'set by the owner' where id = (select rice_id from t);

insert into public.bills (id, merchant_id, supplier_name, bill_number, items, source)
select '55555555-5555-5555-5555-555555555555', merchant_id, 'Sharma Traders', 'A-17',
       jsonb_build_array(
         jsonb_build_object('name', 'Rice', 'quantity', 25, 'unit', 'kg', 'product_id', rice_id, 'hsn', '10063020', 'gst_official', 0, 'gst_citation', 'from the bill'),
         jsonb_build_object('name', 'Toor Dal', 'quantity', 30, 'unit', 'kg', 'product_id', null, 'hsn', '0713', 'gst_rate', 18,
                            'gst_official', 5, 'gst_citation', 'Schedule I, S. No. 20 of Notification No. 9/2025-Central Tax (Rate)'),
         jsonb_build_object('name', 'Groundnut Oil', 'quantity', 15, 'unit', 'ltr', 'product_id', null, 'hsn', '1508', 'gst_citation', 'not used'),
         jsonb_build_object('name', 'Jaggery', 'quantity', 10, 'unit', 'kg', 'product_id', null, 'hsn', '17 01')),
       'telegram'
  from t;

select is(public.apply_bill('55555555-5555-5555-5555-555555555555', (select merchant_id from t)), 3, 'the bill applies as before');

select results_eq(
  $$ select hsn, gst_rate, gst_citation from public.products where name = 'Toor Dal' $$,
  $$ values ('0713'::text, 5.00::numeric(5, 2), 'Schedule I, S. No. 20 of Notification No. 9/2025-Central Tax (Rate)'::text) $$,
  'a new product gets the bill''s HSN code and the official rate, with its citation');
select results_eq(
  $$ select hsn, gst_rate, gst_citation from public.products where name = 'Groundnut Oil' $$,
  $$ values ('1508'::text, null::numeric(5, 2), null::text) $$,
  'with no single official rate, only the HSN code is set');
select results_eq(
  $$ select hsn, gst_rate, gst_citation from public.products where id = (select rice_id from t) $$,
  $$ values ('1006'::text, 5.00::numeric(5, 2), 'set by the owner'::text) $$,
  'a tag already set is not overwritten by a bill');
select is((select hsn from public.products where name = 'Jaggery'), null, 'a code that isn''t 4, 6 or 8 digits is ignored');

select throws_ok($$ update public.products set hsn = '07 13' where name = 'Toor Dal' $$, '23514', null, 'HSN codes are stored as digits only');
select throws_ok($$ update public.products set gst_rate = 41 where name = 'Toor Dal' $$, '23514', null, 'a GST rate above 40% is refused');

select * from finish();
rollback;
