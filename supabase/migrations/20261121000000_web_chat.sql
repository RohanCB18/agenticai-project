-- The web chat's conversation, so a refresh or another device opens it where it was left, as
-- Telegram's thread already does (agent_threads). One thread per shop, stored as the chat UI holds
-- it; the server keeps only the latest messages. Owners can clear it ("New chat").
create table public.web_chat_threads (
  merchant_id uuid primary key references public.merchants (id) on delete cascade,
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.web_chat_threads enable row level security;
-- The chat route saves with the signed-in owner's client. A tampered thread gains nothing: the
-- browser already sends the whole conversation with every message, and approvals are signed.
create policy "owner manages own web chat" on public.web_chat_threads
  for all to authenticated
  using (public.owns_merchant(merchant_id)) with check (public.owns_merchant(merchant_id));
