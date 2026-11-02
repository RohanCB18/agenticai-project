import { connection } from "next/server";
import { Suspense } from "react";
import { formatINR } from "@munshi/db";
import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../login/actions";

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10">
      <Suspense fallback={<p className="text-muted">Opening your books…</p>}>
        <Books />
      </Suspense>
    </main>
  );
}

async function Books() {
  // The Supabase client checks token expiry with Date.now(), so render at request time.
  await connection();
  const merchant = await getCurrentMerchant();
  const supabase = await createClient();
  const [{ data: balances }, { data: lowStock }] = await Promise.all([
    supabase
      .from("customer_balances")
      .select("customer_id, name, outstanding_paise, last_credit_at")
      .gt("outstanding_paise", 0)
      .order("outstanding_paise", { ascending: false }),
    supabase.from("products").select("id, name, unit, stock_qty, reorder_level"),
  ]);

  const totalUdhaar = (balances ?? []).reduce((sum, b) => sum + Number(b.outstanding_paise), 0);
  const reorder = (lowStock ?? []).filter((p) => p.reorder_level !== null && Number(p.stock_qty) <= Number(p.reorder_level));

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted">Khata</p>
          <h1 className="font-display text-3xl font-semibold">{merchant.shopName}</h1>
        </div>
        <form action={signOut}>
          <button className="text-sm text-muted underline-offset-4 hover:underline">Sign out</button>
        </form>
      </header>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-sm text-muted">Udhaar to collect</p>
          <p className="font-display text-4xl font-semibold tabular-nums">{formatINR(totalUdhaar)}</p>
          <p className="text-sm text-muted">{balances?.length ?? 0} customers</p>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-sm text-muted">Items to reorder</p>
          <p className="font-display text-4xl font-semibold tabular-nums">{reorder.length}</p>
          <p className="text-sm text-muted">{reorder.map((p) => p.name).join(", ") || "Stock is healthy"}</p>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-semibold">Who owes you</h2>
        {balances && balances.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {balances.map((b) => (
              <li key={b.customer_id} className="flex items-center justify-between gap-4 px-5 py-3">
                <span>{b.name}</span>
                <span className="font-mono tabular-nums">{formatINR(Number(b.outstanding_paise))}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Nobody owes you anything right now. Say &ldquo;Ramesh took ₹450 on credit&rdquo; to add an entry.</p>
        )}
      </section>
    </>
  );
}
