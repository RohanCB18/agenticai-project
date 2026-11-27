import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Suspense } from "react";
import QRCode from "qrcode";
import { defaultAlertLevel } from "@munshi/agents";
import { getCurrentMerchant } from "@/lib/auth";
import { type BillItem, rupees } from "@/lib/counter-bill";
import { createClient } from "@/lib/supabase/server";
import { AutoRefresh } from "./auto-refresh";
import { DemoControls, OpenControls } from "./shop-controls";

export default function ShopAdminPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6">
      <Suspense fallback={<p className="text-muted">Opening your online store…</p>}>
        <ShopAdmin />
      </Suspense>
    </main>
  );
}

type OrderRow = {
  id: string;
  status: "open" | "paid" | "cancelled";
  method: "upi" | "cash";
  items: BillItem[];
  total_paise: number | string;
  buyer_name: string;
  created_at: string;
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });

/** The owner's view of their online store: open it, share it, and watch orders take stock out. */
async function ShopAdmin() {
  await connection();
  const merchant = await getCurrentMerchant();
  const supabase = await createClient();
  const [{ data: shop }, { data: orders }, { data: products }, h] = await Promise.all([
    supabase.from("merchants").select("shop_slug, shop_open").eq("id", merchant.id).single(),
    supabase
      .from("counter_sales")
      .select("id, status, method, items, total_paise, buyer_name, created_at")
      .eq("channel", "online")
      .order("created_at", { ascending: false })
      .limit(25),
    supabase.from("products").select("id, name, unit, stock_qty, reorder_level, price_paise").order("name"),
    headers(),
  ]);

  // PUBLIC_APP_URL may be set but empty (locally): then the address this page was opened on.
  const origin = process.env.PUBLIC_APP_URL?.replace(/\/$/, "") || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const open = Boolean(shop?.shop_open);
  const url = shop?.shop_slug ? `${origin}/shop/${shop.shop_slug}` : null;
  const qr = open && url ? await QRCode.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: "M" }) : null;

  const shelf = ((products ?? []) as { id: string; name: string; unit: string; stock_qty: number | string; reorder_level: number | string | null; price_paise: number | null }[])
    .map((p) => {
      const alertAt = Number(p.reorder_level ?? defaultAlertLevel(p.unit));
      const stock = Number(p.stock_qty);
      return { ...p, stock, alertAt, low: stock <= alertAt, ratio: alertAt > 0 ? stock / alertAt : stock };
    })
    .sort((a, b) => a.ratio - b.ratio);
  const unpriced = shelf.filter((p) => !p.price_paise).length;
  const paidToday = ((orders ?? []) as OrderRow[]).filter((o) => o.status === "paid" && new Date(o.created_at).toDateString() === new Date().toDateString());

  return (
    <>
      <AutoRefresh every={5000} />
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted">Online store</p>
          <h1 className="font-display text-3xl font-semibold">{merchant.shopName}</h1>
        </div>
        <Link href="/dashboard" className="text-sm text-muted underline-offset-4 hover:underline">
          Back to khata
        </Link>
      </header>

      <section className="grid gap-4 md:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
          <div>
            <p className={`text-sm font-semibold ${open ? "text-accent" : "text-muted"}`}>{open ? "● Open: taking orders" : "○ Closed"}</p>
            <p className="mt-1 text-sm text-muted">
              Customers order from their phones. Each order takes its goods out of stock, exactly like a bill at your counter, and you get it on Telegram. When something reaches
              its alert level, Munshi asks you to restock: one &ldquo;haan&rdquo; orders it and pays the supplier.
            </p>
          </div>
          {url && open && <p className="break-all rounded-md bg-paper px-3 py-2 font-mono text-sm">{url}</p>}
          <OpenControls open={open} url={url} />
          {unpriced > 0 && (
            <p className="text-sm text-muted">
              {unpriced} product{unpriced === 1 ? " has" : "s have"} no price, so {unpriced === 1 ? "it isn't" : "they aren't"} in the store. Add prices on the{" "}
              <Link href="/dashboard/counter" className="underline">
                counter
              </Link>
              .
            </p>
          )}
        </div>
        {qr && (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-white p-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- a data URL made on the server */}
            <img src={qr} alt="QR code of the store's link" width={180} height={180} />
            <p className="text-xs text-neutral-600">Scan to order</p>
          </div>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Orders</h2>
            <p className="text-sm text-muted">
              {paidToday.length} today · {rupees(paidToday.reduce((sum, o) => sum + Number(o.total_paise), 0))}
            </p>
          </div>
          {(orders ?? []).length === 0 ? (
            <p className="text-sm text-muted">No online orders yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {((orders ?? []) as OrderRow[]).map((o) => (
                <li key={o.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{o.buyer_name}</span> <span className="text-muted">· {when(o.created_at)}</span>
                    <span className="block truncate text-muted">{o.items.map((i) => `${i.name} × ${Number(i.quantity.toFixed(3))}`).join(", ")}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-semibold tabular-nums">{rupees(Number(o.total_paise))}</span>
                    <span className={`text-xs ${o.status === "paid" ? "text-accent" : o.status === "open" ? "text-muted" : "text-danger"}`}>
                      {o.status === "paid" ? (o.method === "upi" ? "Paid · UPI" : "Cash on delivery") : o.status === "open" ? "Waiting for UPI" : "Cancelled"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Stock now</h2>
            <p className="text-sm text-muted">{shelf.filter((p) => p.low).length} at alert level</p>
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {shelf.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  <span className={p.low ? "font-semibold text-danger" : ""}>
                    {Number(p.stock.toFixed(3))} {p.unit}
                  </span>
                  <span className="text-xs text-muted">alert at {Number(p.alertAt.toFixed(3))}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="rounded-lg border border-dashed border-line p-5">
        <h2 className="font-display text-lg font-semibold">For a demo</h2>
        <p className="mb-3 mt-1 text-sm text-muted">
          Fill the store with a small supermarket&apos;s everyday range (stock starts a little above each alert level, so a few orders take items low), and refill whatever ran low
          to run the demo again. Both are recorded as stock coming in.
        </p>
        <DemoControls />
      </section>
    </>
  );
}
