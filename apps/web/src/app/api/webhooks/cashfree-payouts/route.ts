import { after } from "next/server";
import { payoutDelivery, payoutsConfigured } from "@/lib/cashfree-payouts";
import { notifyOwner } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";
import { payoutNotice, settlePayout } from "@/lib/supplier-payouts";

/**
 * Cashfree Payouts webhooks (version V2). When a supplier payment lands, fails or is sent back,
 * record it (the ledger entry is written once, however often Cashfree retries) and tell the owner.
 */
export async function POST(request: Request) {
  if (!payoutsConfigured()) return new Response("Cashfree Payouts not configured", { status: 503 });

  const raw = await request.text();
  const delivery = payoutDelivery(raw, request.headers.get("x-webhook-timestamp"), request.headers.get("x-webhook-signature"));
  // Answer 200 to everything that isn't a transfer update (low balance alerts, the dashboard's test
  // event) so Cashfree doesn't count it as a failed delivery and switch the webhook off.
  if (delivery.kind === "ignore") return Response.json({ ignored: true });
  if (delivery.kind === "reject") return new Response("Invalid signature", { status: 401 });

  const { event } = delivery;
  const db = createAdminClient();
  const settled = await settlePayout(db, event);
  if (!settled) return Response.json({ ignored: "unknown transfer" });

  const notice = settled.changed ? payoutNotice(settled, event) : null;
  if (notice) after(() => notifyOwner(db, settled.merchant_id, notice));
  return Response.json({ ok: true });
}
