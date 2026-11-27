"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { rupees } from "@/lib/counter-bill";
import { orderStatus } from "../../actions";

/** While a UPI order waits: a button to pay, and a check with Cashfree every few seconds. */
export function WatchPayment({ slug, orderId, payUrl, totalPaise }: { slug: string; orderId: string; payUrl: string | null; totalPaise: number }) {
  const router = useRouter();
  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(async () => {
      const result = await orderStatus(slug, orderId).catch(() => null);
      if (!stopped && result && "status" in result && result.status !== "open") router.refresh();
    }, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [slug, orderId, router]);

  if (!payUrl) return null;
  return (
    <a href={payUrl} className="mt-4 inline-block rounded-2xl bg-accent px-6 py-3 font-bold text-on-accent">
      Pay {rupees(totalPaise)} by UPI
    </a>
  );
}
