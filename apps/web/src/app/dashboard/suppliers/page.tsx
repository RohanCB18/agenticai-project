import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { formatINR } from "@munshi/db";
import { getCurrentMerchant } from "@/lib/auth";
import { payoutsConfigured } from "@/lib/cashfree-payouts";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { maskedAccount, reconcilePayouts } from "@/lib/supplier-payouts";
import { stopPayouts } from "./actions";
import { PayoutAccountForm } from "./payout-account-form";

export default function SuppliersPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10">
      <Suspense fallback={<p className="text-muted">Opening your suppliers…</p>}>
        <Suppliers />
      </Suspense>
    </main>
  );
}

const STATUS_LABEL: Record<string, string> = { pending: "Waiting for you to pay", success: "Paid", failed: "Not paid", reversed: "Returned" };
/** A Payouts transfer that is pending is already on its way from the balance: nothing for the owner to do. */
const statusLabel = (status: string, provider: string | null) => (status === "pending" && provider === "payouts" ? "On its way" : (STATUS_LABEL[status] ?? status));

async function Suppliers() {
  await connection();
  const merchant = await getCurrentMerchant();
  // Payment pages still waiting: ask Cashfree first, so the list below is what really happened.
  if (process.env.CASHFREE_CLIENT_ID) {
    await reconcilePayouts(createAdminClient(), merchant.id).catch((error: unknown) =>
      console.error("[munshi] payout check failed:", error instanceof Error ? error.message : error),
    );
  }
  const balance = payoutsConfigured();
  const supabase = await createClient();
  const [{ data: suppliers }, { data: payouts }] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id, name, payout_vpa, payout_account_last4, payout_ifsc, beneficiary_status, beneficiary_verified, cashfree_beneficiary_id, cashfree_vendor_id")
      .order("name"),
    supabase
      .from("supplier_payouts")
      .select("id, amount_paise, status, status_description, utr, payment_url, provider, created_at, suppliers(name)")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted">Suppliers</p>
          <h1 className="font-display text-3xl font-semibold">{merchant.shopName}</h1>
        </div>
        <Link href="/dashboard" className="text-sm text-muted underline-offset-4 hover:underline">
          Back to khata
        </Link>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">Who Munshi can pay</h2>
        {suppliers && suppliers.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {suppliers.map((s) => {
              const account = s.cashfree_beneficiary_id || s.cashfree_vendor_id || (s.beneficiary_verified && s.payout_vpa) ? maskedAccount(s) : null;
              // Payouts pays from the balance; Easy Split is the page the owner pays when that can't.
              const ways = [balance && (s.cashfree_beneficiary_id || s.payout_vpa) ? "from balance" : null, s.cashfree_vendor_id ? "payment page" : null].filter(Boolean).join(" or ");
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3">
                  <div>
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-muted">
                      {account
                        ? `${account}${s.payout_ifsc ? ` · ${s.payout_ifsc}` : ""} · pays ${ways || "after Cashfree checks it"}`
                        : "No payout account"}
                    </p>
                  </div>
                  {s.beneficiary_verified ? (
                    <form action={stopPayouts}>
                      <input type="hidden" name="supplierId" value={s.id} />
                      <button className="text-sm text-muted underline-offset-4 hover:underline">Stop payments</button>
                    </form>
                  ) : (
                    <span className="text-sm text-muted">Payments off</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted">No suppliers yet. Add one below to pay them from chat, like &ldquo;Sharma Traders ko payment kar do&rdquo;.</p>
        )}
      </section>

      <PayoutAccountForm />

      {payouts && payouts.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-display text-xl font-semibold">Recent payments to suppliers</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {payouts.map((p) => {
              const supplier = (p.suppliers as unknown as { name: string } | null)?.name ?? "Supplier";
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-3">
                  <div>
                    <p>{supplier}</p>
                    <p className="text-sm text-muted">
                      {new Date(p.created_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}
                      {p.utr ? ` · UTR ${p.utr}` : ""}
                      {p.status === "failed" && p.status_description ? ` · ${p.status_description}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono tabular-nums">{formatINR(Number(p.amount_paise))}</p>
                    <p className={`text-sm ${p.status === "failed" || p.status === "reversed" ? "text-danger" : "text-muted"}`}>{statusLabel(p.status, p.provider)}</p>
                    {p.status === "pending" && p.payment_url && (
                      <a href={p.payment_url} target="_blank" rel="noreferrer" className="text-sm text-accent underline-offset-4 hover:underline">
                        Pay now
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
