-- Supplier payments: Cashfree Payouts first, Easy Split as the fallback.
--
-- Payouts pays from the shop's Cashfree balance with no step after the owner's "haan", so it is
-- the primary way. (Its "ERROR_SELECTING_FUND_SOURCE" failures came from API keys made in another
-- Cashfree account with no wallet; with keys from the wallet's own account, transfers succeed.)
-- Easy Split, a page the owner pays that Cashfree settles to the supplier, stays as the fallback
-- when Payouts can't pay.
--
-- A supplier therefore has two Cashfree ids: a Payouts beneficiary (cashfree_beneficiary_id, as
-- before 26 Nov) and an Easy Split vendor (the new cashfree_vendor_id). The vendor ids saved in
-- cashfree_beneficiary_id since 26 Nov move to the new column; the Payouts beneficiary is added
-- the next time the account is saved, or made from the saved UPI ID the first time it is paid.

alter table public.suppliers add column cashfree_vendor_id text;
comment on column public.suppliers.cashfree_vendor_id is 'The supplier''s Cashfree Easy Split vendor_id: the fallback way to pay them.';
comment on column public.suppliers.cashfree_beneficiary_id is 'The supplier''s Cashfree Payouts beneficiary_id: the primary way to pay them.';
comment on column public.suppliers.beneficiary_status is 'Cashfree''s state of the supplier''s account (vendor or beneficiary): ACTIVE, VERIFIED, IN_BANK_VALIDATION, ...';

update public.suppliers
   set cashfree_vendor_id = cashfree_beneficiary_id,
       cashfree_beneficiary_id = null
 where cashfree_beneficiary_id like 'munshi%' and cashfree_beneficiary_id not like 'munshi\_%';
