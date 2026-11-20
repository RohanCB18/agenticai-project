"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentMerchant } from "@/lib/auth";
import { createBeneficiary, type PayoutAccount, payoutsConfigured } from "@/lib/cashfree-payouts";
import { createClient } from "@/lib/supabase/server";

// Where supplier money goes is set here, by the signed-in owner, and nowhere else: the agent can
// pay a verified account after the owner's OK, but has no way to add or change one.

export type PayoutAccountState = { error?: string; saved?: string };

const VPA = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PHONE = /^(\+?91)?[6-9]\d{9}$/;
/** Cashfree's own check of an account. Anything else (VERIFIED, INITIATED...) can be paid. */
const UNUSABLE = ["INVALID", "FAILED", "CANCELLED", "DELETED"];

export async function addPayoutAccount(_prev: PayoutAccountState, form: FormData): Promise<PayoutAccountState> {
  const merchant = await getCurrentMerchant();
  if (!payoutsConfigured()) return { error: "Supplier payments aren't switched on yet: the Cashfree Payouts keys are missing." };

  const name = String(form.get("name") ?? "").trim();
  const phone = String(form.get("phone") ?? "").replace(/\s/g, "");
  if (name.length < 2 || name.length > 100) return { error: "Write the supplier's name as it appears on their orders, like Sharma Traders." };
  if (phone && !PHONE.test(phone)) return { error: "That phone number doesn't look like an Indian mobile number." };

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
    const { data: created, error } = await db.from("suppliers").insert({ merchant_id: merchant.id, name, phone: phone || null }).select("id").single();
    if (error || !created) return { error: `Couldn't save the supplier: ${error?.message ?? "unknown error"}` };
    supplierId = created.id as string;
  }

  // A new Cashfree beneficiary for every change of details: an old id never points somewhere new.
  const beneficiaryId = `munshi_${randomUUID().replaceAll("-", "")}`;
  let status: string;
  try {
    status = (await createBeneficiary({ beneficiaryId, name, account, phone })).beneficiary_status ?? "INITIATED";
  } catch (error) {
    return { error: `Cashfree didn't accept this account. ${error instanceof Error ? error.message.slice(0, 200) : ""}` };
  }
  const usable = !UNUSABLE.includes(status);

  const { error } = await db
    .from("suppliers")
    .update({
      phone: phone || null,
      payout_vpa: "vpa" in account ? account.vpa : null,
      payout_account_last4: "bankAccount" in account ? account.bankAccount.slice(-4) : null,
      payout_ifsc: "ifsc" in account ? account.ifsc : null,
      cashfree_beneficiary_id: beneficiaryId,
      beneficiary_status: status,
      beneficiary_verified: usable,
    })
    .eq("id", supplierId)
    .eq("merchant_id", merchant.id);
  if (error) return { error: `Couldn't save the account: ${error.message}` };
  await db.from("audit_log").insert({
    merchant_id: merchant.id,
    actor: "owner",
    action: "supplier_payout_account_added",
    details: { supplierId, method: "vpa" in account ? "upi" : "bank", cashfreeStatus: status },
  });

  revalidatePath("/dashboard/suppliers");
  return usable
    ? { saved: `${name} can now be paid through Munshi, after your OK each time.` }
    : { error: `Cashfree says this account is ${status.toLowerCase()}. Check the details with ${name}.` };
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
