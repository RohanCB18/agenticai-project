-- Messaging channels (Telegram now, WhatsApp later): an owner links their chat account by
-- proving they own it (a one-tap deep link or a code sent from it), then voice notes and
-- texts from that account act on their khata.

alter type public.entry_source add value if not exists 'telegram';

create type public.messaging_channel as enum ('telegram', 'whatsapp');

-- A linked chat account. Server-written only: owners can read their link but never set
-- an account id themselves, because only a message from that account proves ownership.
create table public.channel_links (
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  channel public.messaging_channel not null,
  -- Telegram chat id, or WhatsApp phone number in digits.
  external_user_id text not null check (external_user_id ~ '^[0-9]{1,20}$'),
  profile_name text,
  linked_at timestamptz not null default now(),
  primary key (merchant_id, channel),
  unique (channel, external_user_id)
);

-- One-time link codes from the dashboard. Server-written only.
create table public.channel_link_codes (
  code text primary key check (code ~ '^[A-Za-z0-9_-]{6,64}$'),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  channel public.messaging_channel not null,
  expires_at timestamptz not null
);
create index channel_link_codes_merchant_idx on public.channel_link_codes (merchant_id, channel);

-- Conversation memory for channels with no browser to hold it (AI SDK model messages).
create table public.agent_threads (
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  channel public.messaging_channel not null,
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, channel)
);

-- Platforms retry webhooks; each update is processed once.
create table public.inbound_updates (
  channel public.messaging_channel not null,
  external_id text not null,
  received_at timestamptz not null default now(),
  primary key (channel, external_id)
);

alter table public.channel_links enable row level security;
alter table public.channel_link_codes enable row level security;
alter table public.agent_threads enable row level security;
alter table public.inbound_updates enable row level security;

create policy "owner reads own channel links" on public.channel_links
  for select to authenticated using (public.owns_merchant(merchant_id));
create policy "owner reads own threads" on public.agent_threads
  for select to authenticated using (public.owns_merchant(merchant_id));
-- channel_link_codes and inbound_updates: no policies, so only the server (secret key) can touch them.
