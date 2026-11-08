import "server-only";
import { type Customer, type LedgerEntry, pickReminders, type Reminder, REMINDER_MIN_PAISE, type ReminderCandidate, remindersSummary } from "@munshi/agents";
import { formatINR } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkButton } from "@/lib/channels/types";
import { createSupabaseKhataStore } from "@/lib/khata-store";

// The database side of udhaar reminders. Who is due is decided by plain code in @munshi/agents;
// the run that asks the owner and waits for the tap is src/workflows/udhaar-reminders.ts.

export type LinkResult = { name: string; phone: string | null; amount: string; url: string | null; problem?: string };

const OPEN_STATUSES = ["active", "partially_paid"];
const ASKED_WITHIN_DAYS = 7; // older links and QRs can't stop a reminder, so don't read them
const PAGE = 1000; // PostgREST returns at most this many rows per request

/** Today's date in India as YYYYMMDD: the key that makes the scheduled list once a day. */
export function indiaDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replaceAll("-", "");
}

/** Who to remind today, and the message that asks the owner. */
export async function planReminders(db: SupabaseClient, merchantId: string, now = new Date()) {
  const { data: merchant, error } = await db.from("merchants").select("shop_name").eq("id", merchantId).single();
  if (error || !merchant) throw new Error(`Read shop failed: ${error?.message ?? "no shop"}`);
  const reminders = pickReminders(await loadCandidates(db, merchantId, now), now);
  return { shopName: merchant.shop_name as string, reminders, summary: remindersSummary(reminders) };
}

/** Everyone who owes at least the reminder minimum, with what pickReminders needs to judge them. */
export async function loadCandidates(db: SupabaseClient, merchantId: string, now = new Date()): Promise<ReminderCandidate[]> {
  const owing = await allRows<{ customer_id: string; name: string; outstanding_paise: number }>(
    (from, to) =>
      db
        .from("customer_balances")
        .select("customer_id, name, outstanding_paise")
        .eq("merchant_id", merchantId)
        .gte("outstanding_paise", REMINDER_MIN_PAISE)
        .order("customer_id")
        .range(from, to),
    "Read balances",
  );
  if (owing.length === 0) return [];
  const ids = owing.map((b) => b.customer_id);

  const since = new Date(now.getTime() - ASKED_WITHIN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  type Ask = { customer_id: string; status: string; expires_at: string | null; created_at: string };
  const asks = (table: "payment_links" | "payment_qrs") =>
    allRows<Ask>(
      (from, to) =>
        db.from(table).select("customer_id, status, expires_at, created_at").eq("merchant_id", merchantId).in("customer_id", ids).gte("created_at", since).order("created_at").range(from, to),
      `Read ${table}`,
    );
  type EntryRow = { id: string; kind: LedgerEntry["kind"]; amount_paise: number; customer_id: string; note: string | null; created_at: string };
  const [phones, entries, links, qrs] = await Promise.all([
    allRows<{ id: string; phone: string | null }>((from, to) => db.from("customers").select("id, phone").eq("merchant_id", merchantId).in("id", ids).order("id").range(from, to), "Read customers"),
    allRows<EntryRow>(
      (from, to) =>
        db
          .from("ledger_entries")
          .select("id, kind, amount_paise, customer_id, note, created_at")
          .eq("merchant_id", merchantId)
          .in("customer_id", ids)
          .in("kind", ["credit_given", "payment_received"])
          .order("created_at")
          .order("id")
          .range(from, to),
      "Read ledger",
    ),
    asks("payment_links"),
    asks("payment_qrs"),
  ]);

  const phoneOf = new Map(phones.map((c) => [c.id, c.phone]));
  const ledgerOf = Map.groupBy(entries, (e) => e.customer_id);
  const asksOf = Map.groupBy([...links, ...qrs], (a) => a.customer_id);
  return owing.map((b): ReminderCandidate => {
    const asked = asksOf.get(b.customer_id) ?? [];
    return {
      customerId: b.customer_id,
      name: b.name,
      phone: phoneOf.get(b.customer_id) ?? null,
      outstandingPaise: Number(b.outstanding_paise),
      entries: (ledgerOf.get(b.customer_id) ?? []).map((e) => ({
        id: e.id,
        kind: e.kind,
        amountPaise: Number(e.amount_paise),
        customerId: e.customer_id,
        note: e.note,
        createdAt: e.created_at,
      })),
      openRequest: asked.some((a) => OPEN_STATUSES.includes(a.status) && (!a.expires_at || new Date(a.expires_at) > now)),
      lastAskedAt: asked.map((a) => a.created_at).sort().at(-1) ?? null,
    };
  });
}

/**
 * One customer's payment link, for the amount they owe now: the owner may answer hours after
 * the list went out, and the customer may have paid in the meantime.
 */
export async function makeReminderLink(db: SupabaseClient, merchantId: string, shopName: string, reminder: Reminder): Promise<LinkResult> {
  const store = createSupabaseKhataStore(db, merchantId, { source: "telegram", actor: "udhaar-reminders" });
  const [balance] = await store.balances(reminder.customerId);
  const owes = balance?.outstandingPaise ?? 0;
  const result = { name: reminder.name, phone: reminder.phone, amount: formatINR(Math.max(owes, 0)) };
  if (owes < REMINDER_MIN_PAISE) return { ...result, url: null, problem: "paid since the list went out" };

  const { data: customer, error } = await db.from("customers").select("id, name, aliases, phone, language").eq("merchant_id", merchantId).eq("id", reminder.customerId).single();
  if (error || !customer) throw new Error(`Read customer failed: ${error?.message ?? "not found"}`);
  if (!customer.phone) return { ...result, url: null, problem: "no phone number" };
  const link = await store.createPaymentLink({ customer: customer as Customer, amountPaise: owes, purpose: `Udhaar payment to ${shopName}` });
  return { ...result, phone: customer.phone, url: link.url };
}

/** The owner's message once the links exist: one line and one WhatsApp button per customer. */
export function remindersReport(shopName: string, results: LinkResult[]): { text: string; buttons: LinkButton[] } {
  const made = results.filter((r) => r.url);
  const head = made.length
    ? `✅ ${made.length} payment link${made.length === 1 ? "" : "s"} ready. Tap a button to send each one on WhatsApp.`
    : "No payment links were made.";
  const lines = results.map((r) => (r.url ? `• ${r.name}: ${r.amount}\n  ${r.url}` : `• ${r.name}: ${r.problem ?? "no link"}`));
  const buttons = made.map((r) => whatsappButton(r.name, r.phone, paymentNote(r.name, shopName, r.amount, r.url!)));
  return { text: [head, "", ...lines].join("\n"), buttons };
}

/** What the customer reads when the owner forwards a link. */
export function paymentNote(customer: string, shopName: string, amount: string, url: string) {
  return `Namaste ${customer}, ${shopName} ka ${amount} baaki hai. UPI se yahan pay karein: ${url}`;
}

/** Opens WhatsApp with the note typed out, addressed to the customer if their number is known. */
export function whatsappButton(customer: string, phone: string | null, note: string): LinkButton {
  return { text: `Send to ${customer} on WhatsApp`, url: `https://wa.me/${phone?.replace(/\D/g, "") ?? ""}?text=${encodeURIComponent(note)}` };
}

async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${what} failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}
