import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { openStore, storeProducts } from "@/lib/online-shop";
import { createAdminClient } from "@/lib/supabase/admin";
import { Storefront } from "./storefront";

export const metadata: Metadata = { title: "Order online", description: "Groceries from your neighbourhood store, delivered." };

export default function ShopPage({ params }: PageProps<"/shop/[slug]">) {
  return (
    <Suspense fallback={<StoreSkeleton />}>
      <Store params={params} />
    </Suspense>
  );
}

/** The shop's online store: what's on its shelves now, straight from its stock. */
async function Store({ params }: { params: PageProps<"/shop/[slug]">["params"] }) {
  await connection();
  const { slug } = await params;
  const admin = createAdminClient();
  const store = await openStore(admin, slug);
  if (!store) return <Closed />;
  const products = await storeProducts(admin, store.merchantId);
  return <Storefront slug={store.slug} shopName={store.shopName} products={products} />;
}

function Closed() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-3 px-4 py-20 text-center">
      <p className="text-5xl" aria-hidden>
        🛒
      </p>
      <h1 className="font-display text-2xl font-semibold">This shop isn&apos;t taking online orders right now</h1>
      <p className="text-muted">Check the link with the shop, or drop by in person.</p>
    </main>
  );
}

function StoreSkeleton() {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6" aria-busy>
      <div className="h-8 w-48 animate-pulse rounded bg-line" />
      <div className="mt-4 h-11 w-full animate-pulse rounded-xl bg-line" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="aspect-[3/4] animate-pulse rounded-2xl bg-line" />
        ))}
      </div>
    </main>
  );
}
