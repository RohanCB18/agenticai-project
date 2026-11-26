-- Paying suppliers moves from Cashfree Payouts to Cashfree Easy Split. Payouts paid out of a
-- balance kept with Cashfree, and its test account began rejecting every transfer
-- (ERROR_SELECTING_FUND_SOURCE), a setting only Cashfree's team can change. With Easy Split the owner
-- pays a Cashfree payment link split to the supplier, and Cashfree settles that amount to the
-- supplier's account (a "vendor").
--
-- The same tables carry it: a supplier's Cashfree id is now its Easy Split vendor id, and a supplier
-- payment's transfer_id is its payment link's id. Accounts added for Payouts are switched off, since
-- they aren't vendors: the owner adds each supplier's account again.

comment on column public.suppliers.cashfree_beneficiary_id is
  'The supplier''s Cashfree Easy Split vendor_id (a Cashfree Payouts beneficiary_id before 26 Nov 2026).';
comment on column public.suppliers.beneficiary_status is
  'Cashfree''s state of the vendor: IN_BANK_VALIDATION, ACTIVE, BANK_VALIDATION_FAILED, ...';

update public.suppliers
   set cashfree_beneficiary_id = null,
       beneficiary_status = null,
       beneficiary_verified = false,
       payout_vpa = null,
       payout_account_last4 = null,
       payout_ifsc = null
 where cashfree_beneficiary_id is not null;

-- Which way a payment went, so status checks ask about the right thing; and the page the owner pays.
alter table public.supplier_payouts add column provider text not null default 'payouts' check (provider in ('payouts', 'easy_split'));
alter table public.supplier_payouts alter column provider set default 'easy_split';
alter table public.supplier_payouts add column payment_url text;

comment on column public.supplier_payouts.transfer_id is
  'Munshi''s id for the payment: the Cashfree payment link id (Easy Split), or the Payouts transfer id before.';
comment on column public.supplier_payouts.cf_transfer_id is
  'Cashfree''s own id: cf_link_id (Easy Split), or cf_transfer_id (Payouts).';
