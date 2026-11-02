-- Local-only demo data. Test login: demo@munshi.test / munshi-demo-123
-- (auth.users insert fires handle_new_user, which creates the merchant row.)

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated', 'demo@munshi.test',
  extensions.crypt('munshi-demo-123', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"shop_name":"Lakshmi General Stores","owner_name":"Suresh","preferred_language":"kn"}',
  now(), now(), '', '', '', ''
);

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (
  gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"demo@munshi.test"}',
  'email', now(), now(), now()
);

do $$
declare
  m uuid := (select id from public.merchants where owner_id = '11111111-1111-1111-1111-111111111111');
  ramesh uuid; fatima uuid; anand uuid; sharma uuid; milk uuid; rice uuid;
begin
  insert into public.customers (merchant_id, name, aliases, phone, language)
    values (m, 'Ramesh', '{"Ramesh bhaiya","ರಮೇಶ್"}', '+919800000001', 'kn') returning id into ramesh;
  insert into public.customers (merchant_id, name, aliases, phone, language)
    values (m, 'Fatima', '{"Fatima aunty"}', '+919800000002', 'hi') returning id into fatima;
  insert into public.customers (merchant_id, name, aliases, phone, language)
    values (m, 'Anand', '{"ಆನಂದ್"}', '+919800000003', 'kn') returning id into anand;

  insert into public.suppliers (merchant_id, name, phone)
    values (m, 'Sharma Traders', '+919800000010') returning id into sharma;

  insert into public.products (merchant_id, name, aliases, unit, stock_qty, reorder_level, price_paise, supplier_id)
    values (m, 'Nandini Milk 500ml', '{"milk","haalu","ಹಾಲು","doodh"}', 'packet', 40, 24, 2600, sharma) returning id into milk;
  insert into public.products (merchant_id, name, aliases, unit, stock_qty, reorder_level, price_paise, supplier_id)
    values (m, 'Sona Masoori Rice', '{"rice","akki","ಅಕ್ಕಿ","chawal"}', 'kg', 18, 25, 6200, sharma) returning id into rice;

  insert into public.ledger_entries (merchant_id, customer_id, kind, amount_paise, note, source, created_at) values
    (m, ramesh, 'credit_given', 45000, 'Rice and dal', 'voice', now() - interval '12 days'),
    (m, ramesh, 'credit_given', 18000, 'Milk, 1 week', 'voice', now() - interval '5 days'),
    (m, ramesh, 'payment_received', 20000, 'Cash', 'chat', now() - interval '2 days'),
    (m, fatima, 'credit_given', 120000, 'Monthly groceries', 'voice', now() - interval '20 days'),
    (m, anand, 'credit_given', 9500, null, 'whatsapp', now() - interval '1 day');

  insert into public.ledger_entries (merchant_id, kind, amount_paise, note, source) values
    (m, 'sale', 342000, 'Counter sales today', 'system');
end $$;
