"use server";

import { revalidatePath } from "next/cache";
import { getCurrentMerchant } from "@/lib/auth";
import { createVendor, newVendorId, type PayoutAccount, VENDOR_UNUSABLE } from "@/lib/cashfree";
import { BENEFICIARY_UNUSABLE, createBeneficiary, newBeneficiaryId, payoutsConfigured } from "@/lib/cashfree-payouts";
import { createClient } from "@/lib/supabase/server";

// Where supplier money goes is set here, by the signed-in owner, and nowhere else: the agent can
// pay a verified account after the owner's OK, but has no way to add or change one. Each account
// becomes a Cashfree Payouts beneficiary (paid from the shop's balance) and an Easy Split vendor
// (the fallback: a page the owner pays, which Cashfree settles to the supplier).

/** Cashfree's own words from a refused call, without the request details. */
const cashfreeMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/^Cashfree (Payouts )?[a-z ]+ failed \(\d+\): /, "").slice(0, 160);

export type PayoutAccountState = { error?: string; saved?: string };

const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PHONE = /^(\+?91)?[6-9]\d{9}$/;
const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addPayoutAccount(_prev: PayoutAccountState, form: FormData): Promise<PayoutAccountState> {
  const merchant = await getCurrentMerchant();
  if (!process.env.CASHFREE_CLIENT_ID || !process.env.CASHFREE_CLIENT_SECRET) {
    return { error: "Supplier payments aren't switched on yet: the Cashfree keys are missing." };
  }

  const name = String(form.get("name") ?? "").trim();
  const phone = String(form.get("phone") ?? "").replace(/\s/g, "");
  if (name.length < 2 || name.length > 100) return { error: "Write the supplier's name as it appears on their orders, like Sharma Traders." };
  if (!PHONE.test(phone)) return { error: "Cashfree needs the supplier's mobile number: 10 digits, like 98XXXXXXXX." };
  const taxId = String(form.get("taxId") ?? "").replace(/\s/g, "").toUpperCase();
  const kyc = GSTIN.test(taxId) ? { gst: taxId } : PAN.test(taxId) ? { pan: taxId } : null;
  if (!kyc) return { error: "Cashfree needs the supplier's GSTIN (15 characters, on their bill) or PAN (like ABCDE1234F)." };
  const supplierEmail = String(form.get("email") ?? "").trim();
  if (supplierEmail && !EMAIL.test(supplierEmail)) return { error: "That email doesn't look right." };

  let account: PayoutAccount;
  if (form.get("method") === "bank") {
    const bankAccount = String(form.get("account") ?? "").replace(/\s/g, "");
    const ifsc = String(form.get("ifsc") ?? "").trim().toUpperCase();
    if (!/^\d{9,18}$/.test(bankAccount)) return { error: "A bank account number is 9 to 18 digits." };
    if (!IFSC.test(ifsc)) return { error: "An IFSC looks like HDFC0001234: 4 letters, a 0, then 6 letters or digits." };
    account = { bankAccount, ifsc };
  } else {
    const vpa = String(form.get("vpa") ?? "").trim();
    if (!VPA.test(vpa)) return { error: "A UPI ID looks like sharmatraders@okhdfc." };
    account = { vpa };
  }
  if (form.get("confirmed") !== "on") return { error: "Confirm these details with the supplier first, by phone or in person." };

  const db = await createClient();
  // Cashfree needs an email for a vendor; without the supplier's, its settlement emails go to the owner.
  const { data: claims } = await db.auth.getClaims();
  const email = supplierEmail || String(claims?.claims?.email ?? "");
  if (!email) return { error: "Add the supplier's email: Cashfree needs one." };

  // One supplier per name in a shop: the name wholesalers put on their orders, ignoring case.
  const { data: existing } = await db
    .from("suppliers")
    .select("id")
    .eq("merchant_id", merchant.id)
    .ilike("name", name.replace(/[\\%_]/g, (c) => `\\${c}`))
    .limit(1)
    .maybeSingle();
  let supplierId = existing?.id as string | undefined;
  if (!supplierId) {
    const { data: created, error } = await db.from("suppliers").insert({ merchant_id: merchant.id, name, phone }).select("id").single();
    if (error || !created) return { error: `Couldn't save the supplier: ${error?.message ?? "unknown error"}` };
    supplierId = created.id as string;
  }

  // The same account in both of Cashfree's ways to pay: a Payouts beneficiary (primary: paid from
  // the shop's balance) and an Easy Split vendor (fallback: a page the owner pays). New ids for every
  // change of details, so an old id never points somewhere new.
  const errors: string[] = [];
  let beneficiaryId: string | null = null;
  let beneficiaryStatus: string | null = null;
  if (payoutsConfigured()) {
    const id = newBeneficiaryId();
    try {
      beneficiaryStatus = (await createBeneficiary({ beneficiaryId: id, name, account, phone })).beneficiary_status ?? "INITIATED";
      if (!BENEFICIARY_UNUSABLE.includes(beneficiaryStatus)) beneficiaryId = id;
      else errors.push(`Payouts says this account is ${beneficiaryStatus.toLowerCase()}`);
    } catch (error) {
      errors.push(`Payouts: ${cashfreeMessage(error)}`);
    }
  }
  let vendorId: string | null = null;
  let vendorStatus: string | null = null;
  const vendor = newVendorId();
  try {
    vendorStatus = (await createVendor({ vendorId: vendor, name, email, phone, account, kyc })).status ?? "IN_BANK_VALIDATION";
    if (!VENDOR_UNUSABLE.includes(vendorStatus)) vendorId = vendor;
    else errors.push(`Easy Split says this account is ${vendorStatus.toLowerCase().replaceAll("_", " ")}`);
  } catch (error) {
    errors.push(`Easy Split: ${cashfreeMessage(error)}`);
  }
  if (!beneficiaryId && !vendorId) return { error: `Cashfree didn't accept this account. ${errors.join("; ")}. Check the details with ${name}.` };

  const { error } = await db
    .from("suppliers")
    .update({
      phone,
      payout_vpa: "vpa" in account ? account.vpa : null,
      payout_account_last4: "bankAccount" in account ? account.bankAccount.slice(-4) : null,
      payout_ifsc: "ifsc" in account ? account.ifsc : null,
      cashfree_beneficiary_id: beneficiaryId,
      cashfree_vendor_id: vendorId,
      beneficiary_status: beneficiaryStatus ?? vendorStatus,
      beneficiary_verified: true,
    })
    .eq("id", supplierId)
    .eq("merchant_id", merchant.id);
  if (error) return { error: `Couldn't save the account: ${error.message}` };
  await db.from("audit_log").insert({
    merchant_id: merchant.id,
    actor: "owner",
    action: "supplier_payout_account_added",
    details: { supplierId, method: "vpa" in account ? "upi" : "bank", payouts: beneficiaryStatus, easySplit: vendorStatus },
  });

  revalidatePath("/dashboard/suppliers");
  const ways = beneficiaryId
    ? `from your Cashfree balance${vendorId ? ", or with a payment page if that fails" : ""}`
    : "with a Cashfree payment page you pay";
  return { saved: `${name} can now be paid through Munshi, ${ways}, after your OK each time.${errors.length ? ` (${errors.join("; ")}.)` : ""}` };
}

/** Stops Munshi paying a supplier until the owner adds an account again. */
export async function stopPayouts(form: FormData) {
  const merchant = await getCurrentMerchant();
  const supplierId = String(form.get("supplierId") ?? "");
  const db = await createClient();
  await db.from("suppliers").update({ beneficiary_verified: false }).eq("id", supplierId).eq("merchant_id", merchant.id);
  await db.from("audit_log").insert({ merchant_id: merchant.id, actor: "owner", action: "supplier_payouts_stopped", details: { supplierId } });
  revalidatePath("/dashboard/suppliers");
}
