import { timingSafeEqual } from "node:crypto";
import { startReminders } from "@/lib/reminder-runs";
import { indiaDateKey } from "@/lib/reminders";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * Vercel Cron calls this every evening (see vercel.json) with `Authorization: Bearer $CRON_SECRET`.
 * It starts one reminders run per shop with Telegram linked; each run then works on its own.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!sameSecret(request.headers.get("authorization"), `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });

  const admin = createAdminClient();
  const { data: links, error } = await admin.from("channel_links").select("merchant_id, external_user_id").eq("channel", "telegram");
  if (error) throw new Error(`Read Telegram links failed: ${error.message}`);

  const key = indiaDateKey();
  const runs = await Promise.allSettled((links ?? []).map((l) => startReminders({ merchantId: l.merchant_id, chatId: l.external_user_id, key })));
  const started = runs.filter((r) => r.status === "fulfilled" && r.value.started).length;
  const alreadyRan = runs.filter((r) => r.status === "fulfilled" && !r.value.started).length;
  const failed = runs.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
  if (failed.length) console.error("[munshi] reminders cron: some runs didn't start:", failed);
  console.info(`[munshi] reminders cron ${key}: ${started} started, ${alreadyRan} already ran, ${failed.length} failed`);
  return Response.json({ key, started, alreadyRan, failed: failed.length });
}

function sameSecret(given: string | null, expected: string) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
