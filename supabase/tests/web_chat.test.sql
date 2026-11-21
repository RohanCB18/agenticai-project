-- Run with `npx supabase test db`. Each owner reads, saves and clears only their own web chat.
begin;
select plan(5);

-- The demo shop has a saved chat; a second owner signs up.
insert into public.web_chat_threads (merchant_id, messages)
select id, '[{"id":"u1","role":"user","parts":[{"type":"text","text":"Ramesh ne 450 ka saaman liya"}]}]'
  from public.merchants where owner_id = '11111111-1111-1111-1111-111111111111';
insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333',
        'authenticated', 'authenticated', 'chat@munshi.test', '{"shop_name":"Chat Shop"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select is((select count(*)::int from public.web_chat_threads), 0, 'cannot read another shop''s chat');
select lives_ok(
  $$ insert into public.web_chat_threads (merchant_id, messages) values ((select id from public.merchants limit 1), '[]') $$,
  'can save own chat');
select throws_ok(
  $$ insert into public.web_chat_threads (merchant_id, messages)
     values ((select id from public.merchants m where m.owner_id = '11111111-1111-1111-1111-111111111111'), '[]') $$,
  '42501', null, 'cannot write another shop''s chat');

-- The demo owner clears theirs with "New chat".
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select jsonb_array_length(messages) from public.web_chat_threads), 1, 'the owner reads their saved chat');
delete from public.web_chat_threads;
select is((select count(*)::int from public.web_chat_threads), 0, 'and can clear it');

select * from finish();
rollback;
