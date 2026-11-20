-- Run with `npx supabase test db`. A supplier payout is recorded once, only by the server, and an
-- owner can read their own payouts but never write one, settle one, or see another shop's.
begin;
select plan(9);

-- As the server: a verified supplier and a payout on its way.
create temporary table t as
  select m.id as merchant_id from public.merchants m where m.owner_id = '11111111-1111-1111-1111-111111111111';
grant select on t to authenticated;

insert into public.suppliers (id, merchant_id, name, payout_vpa, cashfree_beneficiary_id, beneficiary_status, beneficiary_verified)
select '55555555-5555-5555-5555-555555555555', merchant_id, 'Sharma Traders', 'success@upi', 'munshi_b1', 'VERIFIED', true from t;
insert into public.supplier_payouts (merchant_id, supplier_id, transfer_id, amount_paise, mode)
select merchant_id, '55555555-5555-5555-5555-555555555555', 'munshi_t1', 420000, 'upi' from t;

select is((select changed from public.settle_supplier_payout('munshi_t1', 'success', 'COMPLETED', null, 'UTR1', 'cf1')), true, 'a success is recorded');
select is((select changed from public.settle_supplier_payout('munshi_t1', 'success', 'COMPLETED', null, 'UTR1', 'cf1')), false, 'the same success again changes nothing');
select is((select status::text from public.settle_supplier_payout('munshi_t1', 'failed', 'LATE', null, null, null)), 'success', 'a late failure cannot undo a success');
select is(
  (select count(*)::int from public.ledger_entries where kind = 'supplier_payment' and supplier_id = '55555555-5555-5555-5555-555555555555'),
  1, 'one supplier_payment ledger entry, however often it is reported');

-- As the owner: reading is fine; writing or settling is not.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select count(*)::int from public.supplier_payouts where transfer_id = 'munshi_t1'), 1, 'owners see their own payouts');
select throws_ok(
  $$ insert into public.supplier_payouts (merchant_id, supplier_id, transfer_id, amount_paise, mode)
     values ((select merchant_id from t), '55555555-5555-5555-5555-555555555555', 'munshi_forged', 100, 'upi') $$,
  '42501', null, 'owners cannot forge a payout');
select throws_ok(
  $$ select public.settle_supplier_payout('munshi_t1', 'reversed', null, null, null, null) $$,
  '42501', null, 'owners cannot settle a payout');

-- Another shop's owner sees nothing. (Creating the user is server work; a new user gets a shop.)
reset role;
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'third@munshi.test', '{"shop_name":"Third Shop"}');
set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is((select count(*)::int from public.supplier_payouts), 0, 'another shop sees no payouts');
select is((select count(*)::int from public.suppliers where name = 'Sharma Traders'), 0, 'nor the supplier''s account');

select * from finish();
rollback;
