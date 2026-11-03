import "server-only";
import type { Balance, Customer, KhataStore, LedgerEntry, PaymentLink, Product } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPaymentLink as createCashfreeLink } from "@/lib/cashfree";
import { createAdminClient } from "@/lib/supabase/admin";

const LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000; // udhaar links stay valid for 3 days

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) throw new Error(`${what} failed: ${result.error?.message ?? "no data"}`);
  return result.data;
}

type CustomerRow = { id: string; name: string; aliases: string[]; phone: string | null; language: Customer["language"] };
type EntryRow = { id: string; kind: LedgerEntry["kind"]; amount_paise: number; customer_id: string | null; note: string | null; created_at: string };
type ProductRow = { id: string; name: string; aliases: string[]; unit: string; stock_qty: number | string; reorder_level: number | string | null; price_paise: number | null };

const toEntry = (r: EntryRow): LedgerEntry => ({
  id: r.id,
  kind: r.kind,
  amountPaise: Number(r.amount_paise),
  customerId: r.customer_id,
  note: r.note,
  createdAt: r.created_at,
});

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  unit: r.unit,
  stockQty: Number(r.stock_qty),
  reorderLevel: r.reorder_level === null ? null : Number(r.reorder_level),
  pricePaise: r.price_paise,
});

/**
 * KhataStore backed by Supabase. `db` is the signed-in user's client, so RLS scopes
 * every read and write to this merchant; only payment links use the admin client.
 */
export function createSupabaseKhataStore(db: SupabaseClient, merchantId: string, opts: { source: "chat" | "voice"; traceId?: string }): KhataStore {
  const store: KhataStore = {
    async listCustomers() {
      return must(await db.from("customers").select("id, name, aliases, phone, language").order("name"), "List customers") as CustomerRow[];
    },

    async addCustomer({ name, phone, language, aliases }) {
      return must(
        await db
          .from("customers")
          .insert({ merchant_id: merchantId, name, phone, language, aliases: aliases ?? [] })
          .select("id, name, aliases, phone, language")
          .single(),
        "Add customer",
      ) as CustomerRow;
    },

    async addLedgerEntry({ kind, amountPaise, customerId, note }) {
      const row = must(
        await db
          .from("ledger_entries")
          .insert({ merchant_id: merchantId, kind, amount_paise: amountPaise, customer_id: customerId, note, source: opts.source, trace_id: opts.traceId })
          .select("id, kind, amount_paise, customer_id, note, created_at")
          .single(),
        "Add ledger entry",
      ) as EntryRow;
      return toEntry(row);
    },

    async balances(customerId) {
      let q = db.from("customer_balances").select("customer_id, name, outstanding_paise, last_credit_at, last_payment_at");
      if (customerId) q = q.eq("customer_id", customerId);
      const rows = must(await q, "Read balances") as { customer_id: string; name: string; outstanding_paise: number; last_credit_at: string | null; last_payment_at: string | null }[];
      return rows.map(
        (r): Balance => ({
          customerId: r.customer_id,
          name: r.name,
          outstandingPaise: Number(r.outstanding_paise),
          lastCreditAt: r.last_credit_at,
          lastPaymentAt: r.last_payment_at,
        }),
      );
    },

    async recentEntries(limit, customerId) {
      let q = db.from("ledger_entries").select("id, kind, amount_paise, customer_id, note, created_at").order("created_at", { ascending: false }).limit(limit);
      if (customerId) q = q.eq("customer_id", customerId);
      return (must(await q, "Read ledger") as EntryRow[]).map(toEntry);
    },

    async listProducts() {
      return (must(await db.from("products").select("id, name, aliases, unit, stock_qty, reorder_level, price_paise").order("name"), "List products") as ProductRow[]).map(toProduct);
    },

    async moveStock({ productId, delta, reason }) {
      must(await db.from("stock_movements").insert({ merchant_id: merchantId, product_id: productId, delta, reason, source: opts.source }).select("id").single(), "Move stock");
      return toProduct(must(await db.from("products").select("id, name, aliases, unit, stock_qty, reorder_level, price_paise").eq("id", productId).single(), "Read product") as ProductRow);
    },

    async createPaymentLink({ customer, amountPaise, purpose }): Promise<PaymentLink> {
      if (!customer.phone) throw new Error("Customer has no phone number");

      // The owner already approved in chat (signed AI SDK approval). Record that decision
      // in the approvals table too, so the audit trail lives in the database.
      const approval = must(
        await db
          .from("approvals")
          .insert({
            merchant_id: merchantId,
            action: "payment_link",
            summary: `Payment link for ₹${amountPaise / 100} to ${customer.name}`,
            payload: { customerId: customer.id, amountPaise },
            amount_paise: amountPaise,
            requested_by: "khata-agent",
            trace_id: opts.traceId,
          })
          .select("id")
          .single(),
        "Record approval",
      ) as { id: string };
      must(await db.from("approvals").update({ status: "approved", decided_at: new Date().toISOString() }).eq("id", approval.id).select("id").single(), "Approve");

      const linkId = `munshi_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 50);
      const expiresAt = new Date(Date.now() + LINK_TTL_MS);
      const appUrl = process.env.PUBLIC_APP_URL;
      // Approval status past "approved" is server-written only (RLS), so use the admin client.
      const admin = createAdminClient();
      let link;
      try {
        link = await createCashfreeLink({
          linkId,
          amountPaise,
          purpose,
          customer: { name: customer.name, phone: customer.phone },
          expiresAt,
          // Cashfree only calls https URLs, so local dev relies on the dashboard webhook or a tunnel.
          notifyUrl: appUrl?.startsWith("https://") ? `${appUrl}/api/webhooks/cashfree` : undefined,
          notes: { merchant_id: merchantId, customer_id: customer.id },
        });
      } catch (error) {
        await admin.from("approvals").update({ status: "failed" }).eq("id", approval.id);
        throw error;
      }

      // Payment link rows are server-written only (RLS gives owners read access).
      const row = must(
        await admin
          .from("payment_links")
          .insert({
            merchant_id: merchantId,
            customer_id: customer.id,
            approval_id: approval.id,
            cashfree_link_id: linkId,
            link_url: link.link_url,
            amount_paise: amountPaise,
            status: "active",
            expires_at: expiresAt.toISOString(),
          })
          .select("id")
          .single(),
        "Save payment link",
      ) as { id: string };
      await admin.from("approvals").update({ status: "executed" }).eq("id", approval.id);

      return { id: row.id, url: link.link_url, amountPaise, status: link.link_status, expiresAt: expiresAt.toISOString() };
    },

    async audit(action, details) {
      await db.from("audit_log").insert({ merchant_id: merchantId, actor: "khata-agent", action, details, trace_id: opts.traceId });
    },
  };
  return store;
}
