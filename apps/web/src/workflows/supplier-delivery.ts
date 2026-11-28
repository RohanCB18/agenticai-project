import { sleep } from "workflow";

// Watching one wholesaler order until it arrives, as a durable workflow: ask the wholesaler where
// it is, sleep until it's due (nothing runs while it sleeps, for minutes in a demo or until the
// next morning), ask again, and once it's delivered put the goods in stock and tell the owner.
// Steps import app code dynamically, as in the reminders workflow, to keep Supabase and A2A out of
// the workflow body; times are worked out inside steps, which run on the real clock.

export type DeliveryWatchInput = { merchantId: string; orderRef: string };

/** Checks before Munshi gives up and says so: about 20 hours of half-hourly checks past the expected time. */
const MAX_CHECKS = 40;

type Check = { status: "on_the_way"; wakeAt: string } | { status: "delivered" | "done" | "unknown" };

export async function supplierDelivery({ merchantId, orderRef }: DeliveryWatchInput): Promise<{ status: string; checks: number }> {
  "use workflow";
  for (let checks = 1; checks <= MAX_CHECKS; checks++) {
    const check = await checkOnce(merchantId, orderRef);
    if (check.status !== "on_the_way") return { status: check.status, checks };
    await sleep(new Date(check.wakeAt));
  }
  await giveUp(merchantId, orderRef);
  return { status: "gave_up", checks: MAX_CHECKS };
}

async function checkOnce(merchantId: string, orderRef: string): Promise<Check> {
  "use step";
  const [{ createAdminClient }, { checkDelivery }] = await Promise.all([import("@/lib/supabase/admin"), import("@/lib/deliveries")]);
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  try {
    const result = await checkDelivery(createAdminClient(), merchantId, orderRef);
    if (result.status !== "on_the_way") return result;
    // Until a little after the wholesaler's expected time; if that has passed (running late), every half hour.
    const expected = result.expectedAt ? Date.parse(result.expectedAt) : Number.NaN;
    return { status: "on_the_way", wakeAt: Number.isFinite(expected) && expected > Date.now() ? new Date(expected + 20_000).toISOString() : later(30 * 60_000) };
  } catch (error) {
    // The wholesaler didn't answer: ask again in a while rather than stop watching.
    console.warn(`[munshi] delivery check ${orderRef} failed:`, error instanceof Error ? error.message : error);
    return { status: "on_the_way", wakeAt: later(30 * 60_000) };
  }
}

async function giveUp(merchantId: string, orderRef: string) {
  "use step";
  const [{ createAdminClient }, { notifyOwner }] = await Promise.all([import("@/lib/supabase/admin"), import("@/lib/payments")]);
  await notifyOwner(
    createAdminClient(),
    merchantId,
    `🚚 The wholesaler hasn't confirmed delivering order ${orderRef}. If it came, send me a photo of its bill and I'll add it to stock.`,
  );
}
