import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { defaultAlertLevel } from "@munshi/agents";
import { getCurrentMerchant } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Till, type TillCustomer, type TillProduct } from "./till";

export default function CounterPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6">
      <Suspense fallback={<p className="text-muted">Opening the counter…</p>}>
        <Counter />
      </Suspense>
    </main>
  );
}

/** The till: bill what the customer buys, take the payment, and the stock goes down by itself. */
async function Counter() {
  await connection();
  const merchant = await getCurrentMerchant();
  const supabase = await createClient();
  const [{ data: products }, { data: customers }] = await Promise.all([
    supabase.from("products").select("id, name, aliases, unit, stock_qty, reorder_level, price_paise, barcode").order("name"),
    supabase.from("customers").select("id, name").order("name"),
  ]);

  const tillProducts: TillProduct[] = (products ?? []).map((p) => ({
    id: p.id as string,
    name: p.name as string,
    aliases: (p.aliases as string[]) ?? [],
    unit: p.unit as string,
    stock: Number(p.stock_qty),
    alertAt: Number(p.reorder_level ?? defaultAlertLevel(p.unit as string)),
    pricePaise: p.price_paise === null ? null : Number(p.price_paise),
    barcode: (p.barcode as string | null) ?? null,
  }));
  const tillCustomers: TillCustomer[] = (customers ?? []).map((c) => ({ id: c.id as string, name: c.name as string }));

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted">Counter</p>
          <h1 className="font-display text-3xl font-semibold">{merchant.shopName}</h1>
        </div>
        <Link href="/dashboard" className="text-sm text-muted underline-offset-4 hover:underline">
          Back to khata
        </Link>
      </header>
      <Till products={tillProducts} customers={tillCustomers} />
    </>
  );
}
