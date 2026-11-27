import type { Metadata } from "next";
import Link from "next/link";
import { after, connection } from "next/server";
import { Suspense } from "react";
import { rupees } from "@/lib/counter-bill";
import { afterSaleRecorded, openStore, orderForBuyer } from "@/lib/online-shop";
import { createAdminClient } from "@/lib/supabase/admin";
import { WatchPayment } from "./watch-payment";

export const metadata: Metadata = { title: "Your order" };

export default function OrderPage({ params }: PageProps<"/shop/[slug]/order/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 px-4 py-8">
      <Suspense fallback={<p className="text-muted">Finding your order…</p>}>
        <Order params={params} />
      </Suspense>
    </main>
  );
}

/** An online order as its customer sees it: paid or waiting, what's coming, and where. */
async function Order({ params }: { params: PageProps<"/shop/[slug]/order/[id]">["params"] }) {
  await connection();
  const { slug, id } = await params;
  const admin = createAdminClient();
  const store = await openStore(admin, slug, { evenClosed: true });
  const found = store ? await orderForBuyer(admin, store, id) : null;
  if (!store || !found) {
    return (
      <div className="py-16 text-center">
        <p className="font-display text-2xl font-semibold">We couldn&apos;t find that order</p>
        <p className="mt-2 text-muted">Check the link, or ask the shop.</p>
      </div>
    );
  }
  // Coming back from Cashfree's page: this visit may be what records the payment.
  if (found.recorded) after(() => afterSaleRecorded(admin, store.merchantId, found.order.id));
  const { order } = found;
  const paid = order.status === "paid";
  const placedAt = new Date(order.placedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });

  return (
    <>
      <section className="rounded-3xl border border-line bg-surface p-6 text-center">
        <p className="text-6xl" aria-hidden>
          {paid ? "🛵" : order.status === "open" ? "⏳" : "✖️"}
        </p>
        <h1 className="mt-3 font-display text-2xl font-bold">
          {paid ? "Order placed!" : order.status === "open" ? "Waiting for your payment" : "This order was cancelled"}
        </h1>
        <p className="mt-1 text-muted">
          {paid
            ? `${store.shopName} is packing it. It should reach you in about 30 minutes.`
            : order.status === "open"
              ? "Pay on Cashfree's page and this page updates by itself."
              : "Nothing was charged."}
        </p>
        {order.status === "open" && <WatchPayment slug={slug} orderId={order.id} payUrl={order.payUrl} totalPaise={order.totalPaise} />}
        {paid && (
          <p className="mt-3 inline-block rounded-full bg-paper px-3 py-1 text-sm font-medium">
            {order.method === "upi" ? "✅ Paid by UPI" : "💵 Cash on delivery"} · {rupees(order.totalPaise)}
          </p>
        )}
      </section>

      <section className="rounded-3xl border border-line bg-surface p-5">
        <h2 className="font-semibold">
          {order.items.length} item{order.items.length === 1 ? "" : "s"} from {store.shopName}
        </h2>
        <p className="text-xs text-muted">Ordered {placedAt}</p>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((item) => (
            <li key={item.productId} className="flex justify-between gap-3 py-2.5 text-sm">
              <span>
                {item.name} <span className="text-muted">× {Number(item.quantity.toFixed(3))} {item.unit}</span>
              </span>
              <span className="tabular-nums">{rupees(item.amountPaise)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex justify-between border-t border-line pt-3 font-bold">
          <span>Total</span>
          <span className="tabular-nums">{rupees(order.totalPaise)}</span>
        </div>
        {order.address && (
          <p className="mt-4 rounded-xl bg-paper px-3 py-2.5 text-sm">
            <span aria-hidden>📍</span> {order.buyerName}, {order.address}
          </p>
        )}
      </section>

      <Link href={`/shop/${slug}`} className="rounded-2xl border border-accent px-4 py-3 text-center font-semibold text-accent">
        Order more
      </Link>
    </>
  );
}
