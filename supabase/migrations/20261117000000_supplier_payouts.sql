-- Paying suppliers through Cashfree Payouts. Money only goes to an account the owner added in the
-- dashboard and confirmed with the supplier (suppliers.beneficiary_verified); the agent can ask to
-- pay one, after the owner approves, but can never add or change where money goes.

-- Where a supplier is paid. Cashfree keeps the full account; Munshi keeps enough to show the owner.
alter table public.suppliers
  add column payout_vpa text,                -- UPI ID, when paid by UPI
  add column payout_account_last4 text,      -- bank account, last 4 digits only
  add column payout_ifsc text,
  add column beneficiary_status text;        -- Cashfree's check of the account: VERIFIED, INVALID, ...

create type public.payout_status as enum ('pending', 'success', 'failed', 'reversed');

create table public.supplier_payouts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  supplier_order_id uuid references public.supplier_orders (id) on delete set null,
  approval_id uuid references public.approvals (id) on delete set null,
  transfer_id text not null unique,          -- Munshi's id for the transfer, sent to Cashfree
  cf_transfer_id text,
  amount_paise bigint not null check (amount_paise > 0),
  mode text not null check (mode in ('upi', 'banktransfer')),
  status public.payout_status not null default 'pending',
  status_code text,
  status_description text,
  utr text,                                  -- the bank's reference, once paid
  ledger_entry_id uuid references public.ledger_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index supplier_payouts_merchant_idx on public.supplier_payouts (merchant_id, created_at desc);
create index supplier_payouts_order_idx on public.supplier_payouts (supplier_order_id);

-- Owners read their payouts; only the server writes them (as with payment links).
alter table public.supplier_payouts enable row level security;
create policy "owner reads own supplier payouts" on public.supplier_payouts
  for select to authenticated using (public.owns_merchant(merchant_id));

-- Records what Cashfree reported for a transfer, once. A payout that succeeds gets one
-- supplier_payment ledger entry in the same transaction, so a webhook delivered twice (or a webhook
-- racing the status check) can't write it twice. A final status never changes, except success
-- turning into reversed when the bank returns the money.
create function public.settle_supplier_payout(
  p_transfer_id text,
  p_status public.payout_status,
  p_status_code text,
  p_status_description text,
  p_utr text,
  p_cf_transfer_id text
)
returns table (merchant_id uuid, supplier_id uuid, supplier_name text, amount_paise bigint, status public.payout_status, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  payout public.supplier_payouts;
  entry uuid;
  name text;
begin
  select * into payout from public.supplier_payouts p where p.transfer_id = p_transfer_id for update;
  if not found then
    return;
  end if;
  select s.name into name from public.suppliers s where s.id = payout.supplier_id;

  if payout.status = p_status
     or (payout.status <> 'pending' and not (payout.status = 'success' and p_status = 'reversed'))
     or (p_status = 'pending') then
    -- Nothing new: keep the latest details Cashfree sent, but don't re-record anything.
    update public.supplier_payouts p
       set status_code = coalesce(p_status_code, p.status_code),
           status_description = coalesce(p_status_description, p.status_description),
           cf_transfer_id = coalesce(p_cf_transfer_id, p.cf_transfer_id),
           updated_at = now()
     where p.id = payout.id and payout.status = 'pending';
    return query select payout.merchant_id, payout.supplier_id, name, payout.amount_paise, payout.status, false;
    return;
  end if;

  if p_status = 'success' then
    insert into public.ledger_entries (merchant_id, supplier_id, kind, amount_paise, note, source)
    values (payout.merchant_id, payout.supplier_id, 'supplier_payment', payout.amount_paise,
            'Paid ' || coalesce(name, 'supplier') || coalesce(' · UTR ' || p_utr, ''), 'webhook')
    returning id into entry;
  end if;

  update public.supplier_payouts p
     set status = p_status,
         status_code = coalesce(p_status_code, p.status_code),
         status_description = coalesce(p_status_description, p.status_description),
         utr = coalesce(p_utr, p.utr),
         cf_transfer_id = coalesce(p_cf_transfer_id, p.cf_transfer_id),
         ledger_entry_id = coalesce(entry, p.ledger_entry_id),
         updated_at = now()
   where p.id = payout.id;

  return query select payout.merchant_id, payout.supplier_id, name, payout.amount_paise, p_status, true;
end;
$$;

-- Only the server (webhook, payout tool) settles payouts.
revoke execute on function public.settle_supplier_payout(text, public.payout_status, text, text, text, text) from public, anon, authenticated;
grant execute on function public.settle_supplier_payout(text, public.payout_status, text, text, text, text) to service_role;
