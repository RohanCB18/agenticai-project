import { LINK_STATUS, verifyWebhookSignature } from "@/lib/cashfree";
import { createAdminClient } from "@/lib/supabase/admin";

type LinkEvent = {
  type: string;
  data: { link_id: string; link_status: keyof typeof LINK_STATUS; link_amount_paid: string | number };
};

/**
 * Cashfree PAYMENT_LINK_EVENT webhook. When a customer pays their udhaar link,
 * mark the link paid and write a payment_received entry so the khata updates itself.
 */
export async function POST(request: Request) {
  const secret = process.env.CASHFREE_CLIENT_SECRET;
  if (!secret) return new Response("Cashfree not configured", { status: 503 });

  const raw = await request.text();
  const ok = verifyWebhookSignature(raw, request.headers.get("x-webhook-timestamp"), request.headers.get("x-webhook-signature"), secret);
  if (!ok) return new Response("Invalid signature", { status: 401 });

  let event: LinkEvent;
  try {
    event = JSON.parse(raw) as LinkEvent;
  } catch {
    return new Response("Expected a JSON body", { status: 400 });
  }
  // Acknowledge other event types so Cashfree stops retrying them.
  if (event.type !== "PAYMENT_LINK_EVENT") return Response.json({ ignored: event.type });

  const status = LINK_STATUS[event.data.link_status];
  if (!status) return Response.json({ ignored: event.data.link_status });
  const paidPaise = Math.round(Number(event.data.link_amount_paid ?? 0) * 100);

  const db = createAdminClient();
  const { data: link } = await db
    .from("payment_links")
    .select("id, merchant_id, customer_id, amount_paid_paise")
    .eq("cashfree_link_id", event.data.link_id)
    .maybeSingle();
  if (!link) return Response.json({ ignored: "unknown link" });

  const previouslyPaid = Number(link.amount_paid_paise);
  const newlyPaid = paidPaise - previouslyPaid;

  // Conditional update: if Cashfree delivers the same event twice concurrently, only one
  // delivery wins this row and records the payment, so the ledger is never double-counted.
  const { data: updated } = await db
    .from("payment_links")
    .update({ status, amount_paid_paise: Math.max(paidPaise, previouslyPaid), updated_at: new Date().toISOString() })
    .eq("id", link.id)
    .eq("amount_paid_paise", previouslyPaid)
    .select("id");

  if (updated?.length && newlyPaid > 0 && link.customer_id) {
    await db.from("ledger_entries").insert({
      merchant_id: link.merchant_id,
      customer_id: link.customer_id,
      kind: "payment_received",
      amount_paise: newlyPaid,
      note: "UPI via Cashfree payment link",
      source: "webhook",
    });
    await db.from("audit_log").insert({
      merchant_id: link.merchant_id,
      actor: "cashfree-webhook",
      action: "payment_link_paid",
      details: { linkId: link.id, newlyPaid, status },
    });
  }

  return Response.json({ ok: true });
}
