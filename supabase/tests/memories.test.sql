-- Run with `npx supabase test db`. A shop's memories stay with that shop.
begin;
select plan(3);

insert into public.memories (merchant_id, fact, source)
  select id, 'Call the owner Akka', 'telegram' from public.merchants where owner_id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '55555555-5555-5555-5555-555555555555',
        'authenticated', 'authenticated', 'fifth@munshi.test', '{"shop_name":"Fifth Shop"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
select is((select count(*)::int from public.memories), 0, 'cannot read another shop''s memories');
select throws_ok(
  $$ insert into public.memories (merchant_id, fact, source)
     values ((select id from public.merchants m where m.owner_id = '11111111-1111-1111-1111-111111111111'), 'planted', 'chat') $$,
  '42501', null, 'cannot plant a memory in another shop');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select count(*)::int from public.memories where fact = 'Call the owner Akka'), 1, 'owner reads own memories');

select * from finish();
rollback;
