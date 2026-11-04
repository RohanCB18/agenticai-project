-- Run with `npx supabase test db`. Proves one merchant can never see or touch another's books.
begin;
select plan(8);

-- A second merchant alongside the seeded demo merchant.
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
        'authenticated', 'authenticated', 'other@munshi.test', '{"shop_name":"Other Shop"}');

select is(
  (select count(*)::int from public.merchants where owner_id = '22222222-2222-2222-2222-222222222222'),
  1, 'signup trigger creates a merchant');

-- Act as the second merchant.
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is((select count(*)::int from public.merchants), 1, 'sees only own merchant');
select is((select count(*)::int from public.ledger_entries), 0, 'cannot read demo ledger');
select is((select count(*)::int from public.customer_balances), 0, 'balances view respects RLS');

select throws_ok(
  $$ insert into public.ledger_entries (merchant_id, kind, amount_paise, source)
     values ((select id from public.merchants m where m.owner_id = '11111111-1111-1111-1111-111111111111'), 'sale', 100, 'chat') $$,
  '42501', null, 'cannot write into another merchant''s ledger');

select lives_ok(
  $$ insert into public.ledger_entries (merchant_id, kind, amount_paise, source)
     values ((select id from public.merchants limit 1), 'sale', 100, 'chat') $$,
  'can write own ledger');

select throws_ok(
  $$ insert into public.approvals (merchant_id, action, status, summary, payload, requested_by)
     values ((select id from public.merchants limit 1), 'supplier_payout', 'approved', 'x', '{}', 'agent') $$,
  '42501', null, 'agents cannot create pre-approved approvals');

-- Act as the demo merchant: balances are computed in paise.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is(
  (select outstanding_paise from public.customer_balances where name = 'Ramesh'),
  -- Computed from the ledger rather than hard-coded, so it holds after local testing adds entries.
  (select coalesce(sum(case kind when 'credit_given' then amount_paise when 'payment_received' then -amount_paise else 0 end), 0)::bigint
     from public.ledger_entries l join public.customers c on c.id = l.customer_id where c.name = 'Ramesh'),
  'Ramesh''s balance is credit given minus payments received');

select * from finish();
rollback;
