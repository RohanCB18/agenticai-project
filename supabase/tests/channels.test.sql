-- Run with `npx supabase test db`. Owners can't claim a chat account or see link codes.
begin;
select plan(5);

-- Server-side setup (as postgres): the demo merchant has linked Telegram and holds a code.
insert into public.channel_links (merchant_id, channel, external_user_id)
  select id, 'telegram', '700000001' from public.merchants where owner_id = '11111111-1111-1111-1111-111111111111';
insert into public.channel_link_codes (code, merchant_id, channel, expires_at)
  select 'tg_link_code_123', id, 'telegram', now() + interval '15 minutes' from public.merchants where owner_id = '11111111-1111-1111-1111-111111111111';

insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333',
        'authenticated', 'authenticated', 'third@munshi.test', '{"shop_name":"Third Shop"}');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';

select throws_ok(
  $$ insert into public.channel_links (merchant_id, channel, external_user_id) values ((select id from public.merchants limit 1), 'telegram', '700000002') $$,
  '42501', null, 'owners cannot link a chat account without proving they own it');
select is((select count(*)::int from public.channel_links), 0, 'cannot see another shop''s linked account');
select is((select count(*)::int from public.channel_link_codes), 0, 'link codes are invisible to owners');

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
select is((select external_user_id from public.channel_links where channel = 'telegram'), '700000001', 'owner sees own linked account');
select is((select count(*)::int from public.channel_link_codes), 0, 'even own link codes stay server-only');

select * from finish();
rollback;
