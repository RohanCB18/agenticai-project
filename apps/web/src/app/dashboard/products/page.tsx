import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export default function ProductsPage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-10">
      <Suspense fallback={<p className="text-muted">Opening your products…</p>}>
        <Products />
      </Suspense>
    </main>
  );
}

/** Each product's HSN code and GST rate: set from approved bills, or by asking Munshi. Read-only here. */
async function Products() {
  await connection();
  const merchant = await getCurrentMerchant();
  const supabase = await createClient();
  const { data: products } = await supabase.from("products").select("id, name, unit, stock_qty, hsn, gst_rate, gst_citation").order("name");
  const rows = products ?? [];
  const tagged = rows.filter((p) => p.hsn && p.gst_rate !== null).length;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted">Products and GST</p>
          <h1 className="font-display text-3xl font-semibold">{merchant.shopName}</h1>
        </div>
        <Link href="/dashboard" className="text-sm text-muted underline-offset-4 hover:underline">
          Back to khata
        </Link>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-xl font-semibold">HSN codes and GST rates</h2>
          <p className="text-sm text-muted">
            {tagged} of {rows.length} tagged
          </p>
        </div>
        <p className="text-sm text-muted">
          Tags come from supplier bills you approve, or ask Munshi: &ldquo;Maggi ka HSN laga do&rdquo;. Every rate is copied from the official notification shown, never
          typed in.
        </p>
        {rows.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-sm text-muted">
                    {Number(p.stock_qty)} {p.unit}
                    {p.gst_citation ? ` · ${p.gst_citation}` : ""}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-sm tabular-nums">
                  {p.hsn ? `HSN ${p.hsn} · ${p.gst_rate === null ? "rate to choose" : `${Number(p.gst_rate)}% GST`}` : <span className="text-muted">Not tagged</span>}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No products yet. Tell Munshi “Maggi naya product hai, 20 packet aaye”, or send a photo of a supplier bill on Telegram.</p>
        )}
      </section>
    </>
  );
}
