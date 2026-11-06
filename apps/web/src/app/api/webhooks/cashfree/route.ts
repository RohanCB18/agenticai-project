import { after } from "next/server";
import { type CashfreeEvent, parseCashfreeEvent, verifyWebhookSignature } from "@/lib/cashfree";
import { notifyOwnerOfPayment, settlePayment } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Cashfree webhooks. When a customer pays a link or an in-shop QR, record it so the khata
 * updates itself, then tell the owner on their chat app.
 */
export async function POST(request: Request) {
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!secret) return new Response("Cashfree not configured", { status: 503 });

  const raw = await request.text();
  const ok = verifyWebhookSignature(raw, request.headers.get("x-webhook-timestamp"), request.headers.get("x-webhook-signature"), secret);
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let event: CashfreeEvent | null;
  try {
    event = parseCashfreeEvent(raw);
  } catch {
    return new Response("Expected a JSON body", { status: 400 });
  }
  // Acknowledge other event types so Cashfree stops retrying them.
  if (!event) return Response.json({ ignored: true });

  const db = createAdminClient();
  const row =
    event.kind === "link"
      ? (await db.from("payment_links").select("id, merchant_id, customer_id, amount_paid_paise").eq("cashfree_link_id", event.linkId).maybeSingle()).data
      : (await db.from("payment_qrs").select("id, merchant_id, customer_id, amount_paid_paise").eq("cashfree_order_id", event.orderId).maybeSingle()).data;
  // Payment links also fire order events with Cashfree's own order ids; those are skipped here.
  if (!row) return Response.json({ ignored: "unknown payment" });

  const newlyPaid = await settlePayment(
    db,
    event.kind === "link" ? "payment_links" : "payment_qrs",
    row,
    event.paidPaise,
    event.kind === "link" ? event.status : "paid",
  );

  if (newlyPaid > 0 && row.customer_id) {
    const customerId: string = row.customer_id;
    after(() => notifyOwnerOfPayment(db, row.merchant_id, customerId, newlyPaid));
  }
  return Response.json({ ok: true });
}
