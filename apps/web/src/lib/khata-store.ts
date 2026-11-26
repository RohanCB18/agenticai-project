import "server-only";
import type { Balance, Customer, KhataStore, LedgerEntry, PaymentLink, Product, Supplier, SupplierPayout } from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cashfreeSendsSms, createPaymentLink as createCashfreeLink, createUpiQr } from "@/lib/cashfree";
import { cancelOpenRequests, reconcilePayments } from "@/lib/payments";
import { createAdminClient } from "@/lib/supabase/admin";
import { maskedAccount, settlePayout } from "@/lib/supplier-payouts";

const LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000; // udhaar links stay valid for 3 days
const SUPPLIER_LINK_TTL_MS = 24 * 60 * 60 * 1000; // a supplier payment page is for paying now, so a day
const QR_TTL_MS = 20 * 60 * 1000; // a counter QR only needs to last while the customer is there

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null) throw new Error(`${what} failed: ${result.error?.message ?? "no data"}`);
  return result.data;
}

type CustomerRow = { id: string; name: string; aliases: string[]; phone: string | null; language: Customer["language"] };
type EntryRow = { id: string; kind: LedgerEntry["kind"]; amount_paise: number; customer_id: string | null; note: string | null; created_at: string; source?: string };
type ProductRow = {
  id: string;
  name: string;
  aliases: string[];
  unit: string;
  stock_qty: number | string;
  reorder_level: number | string | null;
  price_paise: number | null;
  hsn: string | null;
  gst_rate: number | string | null;
  gst_citation: string | null;
};
const PRODUCT_COLUMNS = "id, name, aliases, unit, stock_qty, reorder_level, price_paise, hsn, gst_rate, gst_citation";

const toEntry = (r: EntryRow): LedgerEntry => ({
  id: r.id,
  kind: r.kind,
  amountPaise: Number(r.amount_paise),
  customerId: r.customer_id,
  note: r.note,
  createdAt: r.created_at,
  ...(r.source ? { source: r.source } : {}),
});

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  unit: r.unit,
  stockQty: Number(r.stock_qty),
  reorderLevel: r.reorder_level === null ? null : Number(r.reorder_level),
  pricePaise: r.price_paise,
  hsn: r.hsn,
  gstRate: r.gst_rate === null ? null : Number(r.gst_rate),
  gstCitation: r.gst_citation,
});

/**
 * KhataStore backed by Supabase. In the web app `db` is the signed-in user's client, so RLS
 * also scopes every query; channels with no browser session (WhatsApp) pass the admin client.
 * Every query filters by merchant explicitly so the store is safe with either.
 */
export function createSupabaseKhataStore(db: SupabaseClient, merchantId: string, opts: { source: "chat" | "voice" | "telegram" | "whatsapp" | "mcp"; traceId?: string; actor?: string }): KhataStore {
  /** A failed cancel is logged, never fatal: the entry or new request matters more. */
  async function closeOpenRequests(customerId: string) {
    try {
      await cancelOpenRequests(createAdminClient(), merchantId, customerId);
    } catch (error) {
      console.warn("[munshi] couldn't close open payment requests:", error instanceof Error ? error.message : error);
    }
  }

  const actor = opts.actor ?? "khata-agent"; // who asked for a write, for approvals and the audit log

  const store: KhataStore = {
    async listCustomers() {
      return must(await db.from("customers").select("id, name, aliases, phone, language").eq("merchant_id", merchantId).order("name"), "List customers") as CustomerRow[];
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

    async updateCustomer(customerId, { name, aliases, phone }) {
      const changes = Object.fromEntries(Object.entries({ name, aliases, phone }).filter(([, value]) => value !== undefined));
      return must(
        await db.from("customers").update(changes).eq("id", customerId).eq("merchant_id", merchantId).select("id, name, aliases, phone, language").single(),
        "Update customer",
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
      // The balance changed, so any open link or QR now asks for the wrong amount.
      if (customerId && (kind === "credit_given" || kind === "payment_received")) await closeOpenRequests(customerId);
      return toEntry(row);
    },

    async balances(customerId) {
      let q = db.from("customer_balances").select("customer_id, name, outstanding_paise, last_credit_at, last_payment_at").eq("merchant_id", merchantId);
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

    async correctLedgerEntry(entryId, amountPaise) {
      const old = must(
        await db.from("ledger_entries").select("id, kind, amount_paise, customer_id, note, created_at, source").eq("id", entryId).eq("merchant_id", merchantId).single(),
        "Read ledger entry",
      ) as EntryRow;
      // The old entry goes to the audit log first: a correction never loses what was written.
      await store.audit("ledger_entry_corrected", { entryId, kind: old.kind, customerId: old.customer_id, was: Number(old.amount_paise), now: amountPaise, recordedAt: old.created_at });
      if (amountPaise === null) must(await db.from("ledger_entries").delete().eq("id", entryId).eq("merchant_id", merchantId).select("id").single(), "Remove ledger entry");
      else must(await db.from("ledger_entries").update({ amount_paise: amountPaise }).eq("id", entryId).eq("merchant_id", merchantId).select("id").single(), "Correct ledger entry");
      if (old.customer_id && (old.kind === "credit_given" || old.kind === "payment_received")) await closeOpenRequests(old.customer_id);
    },

    async addProduct({ name, unit }) {
      const product = toProduct(
        must(await db.from("products").insert({ merchant_id: merchantId, name, unit }).select(PRODUCT_COLUMNS).single(), "Add product") as ProductRow,
      );
      await store.audit("product_added", { productId: product.id, name, unit });
      return product;
    },

    async recentEntries(limit, customerId) {
      let q = db
        .from("ledger_entries")
        .select("id, kind, amount_paise, customer_id, note, created_at, source")
        .eq("merchant_id", merchantId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (customerId) q = q.eq("customer_id", customerId);
      return (must(await q, "Read ledger") as EntryRow[]).map(toEntry);
    },

    async listProducts() {
      return (
        must(await db.from("products").select(PRODUCT_COLUMNS).eq("merchant_id", merchantId).order("name"), "List products") as ProductRow[]
      ).map(toProduct);
    },

    async moveStock({ productId, delta, reason }) {
      must(await db.from("stock_movements").insert({ merchant_id: merchantId, product_id: productId, delta, reason, source: opts.source }).select("id").single(), "Move stock");
      return toProduct(
        must(await db.from("products").select(PRODUCT_COLUMNS).eq("id", productId).eq("merchant_id", merchantId).single(), "Read product") as ProductRow,
      );
    },

    async setReorderLevel(productId, level) {
      return toProduct(
        must(
          await db
            .from("products")
            .update({ reorder_level: level })
            .eq("id", productId)
            .eq("merchant_id", merchantId)
            .select(PRODUCT_COLUMNS)
            .single(),
          "Set reorder level",
        ) as ProductRow,
      );
    },

    async setProductGst(productId, { hsn, gstRate, citation }) {
      const product = toProduct(
        must(
          await db
            .from("products")
            .update({ hsn, gst_rate: gstRate, gst_citation: citation })
            .eq("id", productId)
            .eq("merchant_id", merchantId)
            .select(PRODUCT_COLUMNS)
            .single(),
          "Tag product GST",
        ) as ProductRow,
      );
      await store.audit("product_gst_tagged", { productId, hsn, gstRate, citation });
      return product;
    },

    async createPaymentLink({ customer, amountPaise, purpose }): Promise<PaymentLink> {
      if (!customer.phone) throw new Error("Customer has no phone number");
      // One open request per customer, as for QRs: live, Ramesh had three ₹650 links open at once.
      await closeOpenRequests(customer.id);

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
            requested_by: actor,
            trace_id: opts.traceId,
          })
          .select("id")
          .single(),
        "Record approval",
      ) as { id: string };
      must(
        await db.from("approvals").update({ status: "approved", decided_at: new Date().toISOString() }).eq("id", approval.id).eq("merchant_id", merchantId).select("id").single(),
        "Approve",
      );

      await closeOpenRequests(customer.id); // one open request per customer, so nobody can pay twice
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

      return { id: row.id, url: link.link_url, amountPaise, status: link.link_status, expiresAt: expiresAt.toISOString(), customerNotified: cashfreeSendsSms() };
    },

    async createPaymentQr({ customer, amountPaise, purpose }) {
      await closeOpenRequests(customer.id); // one open request per customer, so nobody can pay twice
      const orderId = `munshi_qr_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 45);
      const expiresAt = new Date(Date.now() + QR_TTL_MS);
      const appUrl = process.env.PUBLIC_APP_URL;
      const { qrPng } = await createUpiQr({
        orderId,
        amountPaise,
        customer,
        expiresAt,
        note: purpose,
        notifyUrl: appUrl?.startsWith("https://") ? `${appUrl}/api/webhooks/cashfree` : undefined,
      });

      // QR rows are server-written only (RLS gives owners read access).
      const row = must(
        await createAdminClient()
          .from("payment_qrs")
          .insert({
            merchant_id: merchantId,
            customer_id: customer.id,
            cashfree_order_id: orderId,
            amount_paise: amountPaise,
            qr_png: qrPng,
            expires_at: expiresAt.toISOString(),
          })
          .select("id")
          .single(),
        "Save payment QR",
      ) as { id: string };
      return { id: row.id, amountPaise, expiresAt: expiresAt.toISOString() };
    },

    async checkPayments(customerId) {
      // Payment tables are server-written only, so this needs the admin client in every channel.
      return reconcilePayments(createAdminClient(), merchantId, customerId);
    },

    async remember({ fact, customerId }) {
      const row = must(
        await db.from("memories").insert({ merchant_id: merchantId, customer_id: customerId ?? null, fact, source: opts.source }).select("id, fact, customer_id, created_at").single(),
        "Remember",
      ) as { id: string; fact: string; customer_id: string | null; created_at: string };
      return { id: row.id, fact: row.fact, customerId: row.customer_id, createdAt: row.created_at };
    },

    async memories(customerId) {
      let q = db.from("memories").select("id, fact, customer_id, created_at").eq("merchant_id", merchantId).order("created_at");
      q = customerId === null ? q.is("customer_id", null) : q.eq("customer_id", customerId);
      const rows = must(await q, "Recall") as { id: string; fact: string; customer_id: string | null; created_at: string }[];
      return rows.map((r) => ({ id: r.id, fact: r.fact, customerId: r.customer_id, createdAt: r.created_at }));
    },

    async forget(memoryId) {
      const { data } = await db.from("memories").delete().eq("id", memoryId).eq("merchant_id", merchantId).select("id");
      return Boolean(data?.length);
    },

    async audit(action, details) {
      await db.from("audit_log").insert({ merchant_id: merchantId, actor, action, details, trace_id: opts.traceId });
    },

    async saveSupplierOrder(order) {
      const { error } = await db.from("supplier_orders").upsert(
        {
          merchant_id: merchantId,
          supplier: order.supplier,
          order_ref: order.orderId,
          quote_id: order.quoteId,
          lines: order.lines,
          total_paise: order.totalPaise,
          delivery_slot: order.deliverySlot,
          payment: order.payment,
        },
        { onConflict: "merchant_id,supplier,order_ref", ignoreDuplicates: true },
      );
      if (error) throw new Error(`Save supplier order failed: ${error.message}`);
      await store.audit("supplier_order_placed", { supplier: order.supplier, orderId: order.orderId, totalPaise: order.totalPaise });
    },

    async saveChart({ title, png }) {
      // Charts are written by the server only (RLS gives owners read access).
      const row = must(
        await createAdminClient()
          .from("charts")
          .insert({ merchant_id: merchantId, title: title.slice(0, 120), png_base64: Buffer.from(png).toString("base64") })
          .select("id")
          .single(),
        "Save chart",
      ) as { id: string };
      return { id: row.id };
    },

    async listSuppliers() {
      const rows = must(
        await db
          .from("suppliers")
          .select("id, name, payout_vpa, payout_account_last4, cashfree_beneficiary_id, beneficiary_verified")
          .eq("merchant_id", merchantId)
          .order("name"),
        "List suppliers",
      ) as SupplierRow[];
      return rows.map(toSupplier);
    },

    async unpaidSupplierOrders(supplierName) {
      // Wholesalers name themselves on orders; match that name exactly, ignoring case.
      const exact = supplierName.replace(/[\\%_]/g, (c) => `\\${c}`);
      const orders = must(
        await db
          .from("supplier_orders")
          .select("id, order_ref, total_paise, created_at")
          .eq("merchant_id", merchantId)
          .ilike("supplier", exact)
          .neq("status", "cancelled")
          .order("created_at", { ascending: false })
          .limit(20),
        "List supplier orders",
      ) as { id: string; order_ref: string; total_paise: number | string; created_at: string }[];
      if (orders.length === 0) return [];
      const { data: paying, error } = await db
        .from("supplier_payouts")
        .select("supplier_order_id")
        .eq("merchant_id", merchantId)
        .in("status", ["pending", "success"])
        .in(
          "supplier_order_id",
          orders.map((o) => o.id),
        );
      if (error) throw new Error(`Read supplier payouts failed: ${error.message}`);
      const paid = new Set((paying ?? []).map((p) => p.supplier_order_id as string));
      return orders.filter((o) => !paid.has(o.id)).map((o) => ({ id: o.id, orderRef: o.order_ref, totalPaise: Number(o.total_paise), createdAt: o.created_at }));
    },

    async paySupplier({ supplier, amountPaise, supplierOrderId }): Promise<SupplierPayout> {
      // Checked again from the database: where money goes is never taken from the caller's copy.
      const row = must(
        await db
          .from("suppliers")
          .select("id, name, payout_vpa, payout_account_last4, cashfree_beneficiary_id, beneficiary_verified")
          .eq("id", supplier.id)
          .eq("merchant_id", merchantId)
          .single(),
        "Read supplier",
      ) as SupplierRow;
      if (!row.beneficiary_verified || !row.cashfree_beneficiary_id) throw new Error("This supplier has no verified payout account");

      // The owner approved in chat (signed AI SDK approval); keep that decision in the audit trail too.
      const approval = must(
        await db
          .from("approvals")
          .insert({
            merchant_id: merchantId,
            action: "supplier_payout",
            summary: `Pay ₹${amountPaise / 100} to ${row.name}`,
            payload: { supplierId: row.id, amountPaise, supplierOrderId: supplierOrderId ?? null },
            amount_paise: amountPaise,
            requested_by: actor,
            trace_id: opts.traceId,
          })
          .select("id")
          .single(),
        "Record approval",
      ) as { id: string };
      must(
        await db.from("approvals").update({ status: "approved", decided_at: new Date().toISOString() }).eq("id", approval.id).eq("merchant_id", merchantId).select("id").single(),
        "Approve",
      );

      // Easy Split: a Cashfree payment page the owner pays, all of it settled to the supplier's
      // vendor account. Saved before Cashfree is asked, so a webhook that races the answer finds it.
      const admin = createAdminClient();
      const linkId = `munshi_${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 50);
      const mode = row.payout_vpa ? ("upi" as const) : ("banktransfer" as const);
      const payout = must(
        await admin
          .from("supplier_payouts")
          .insert({
            merchant_id: merchantId,
            supplier_id: row.id,
            supplier_order_id: supplierOrderId ?? null,
            approval_id: approval.id,
            transfer_id: linkId,
            provider: "easy_split",
            amount_paise: amountPaise,
            mode,
          })
          .select("id")
          .single(),
        "Save payout",
      ) as { id: string };

      // The owner pays, so the page carries their name and number (Cashfree needs a phone).
      const { data: owner } = await admin.from("merchants").select("owner_name, shop_name, phone").eq("id", merchantId).single();
      const order = supplierOrderId ? (await db.from("supplier_orders").select("order_ref").eq("id", supplierOrderId).maybeSingle()).data : null;
      const appUrl = process.env.PUBLIC_APP_URL;
      let link;
      try {
        link = await createCashfreeLink({
          linkId,
          amountPaise,
          purpose: `Payment to ${row.name}${order?.order_ref ? ` for order ${order.order_ref}` : ""}, through Munshi`,
          customer: { name: owner?.owner_name || owner?.shop_name || "Shop owner", phone: owner?.phone || "9999999999" },
          expiresAt: new Date(Date.now() + SUPPLIER_LINK_TTL_MS),
          notifyUrl: appUrl?.startsWith("https://") ? `${appUrl}/api/webhooks/cashfree` : undefined,
          notes: { merchant_id: merchantId, supplier_id: row.id, purpose: "supplier_payment" },
          splits: [{ vendorId: row.cashfree_beneficiary_id, amountPaise }],
        });
      } catch (error) {
        console.error(`[munshi] supplier payment ${linkId}: Cashfree didn't make the page:`, error instanceof Error ? error.message : error);
        await settlePayout(admin, { transferId: linkId, status: "failed", statusCode: null, description: "Cashfree didn't make the payment page", utr: null, cfTransferId: null });
        await admin.from("approvals").update({ status: "failed" }).eq("id", approval.id);
        throw error;
      }

      console.info(`[munshi] supplier payment ${linkId}: page made, split to vendor ${row.cashfree_beneficiary_id}`);
      await admin.from("supplier_payouts").update({ payment_url: link.link_url, cf_transfer_id: String(link.cf_link_id) }).eq("id", payout.id);
      await admin.from("approvals").update({ status: "executed" }).eq("id", approval.id);
      return { id: payout.id, status: "pending", amountPaise, utr: null, reason: null, paymentUrl: link.link_url };
    },
  };
  return store;
}

type SupplierRow = {
  id: string;
  name: string;
  payout_vpa: string | null;
  payout_account_last4: string | null;
  cashfree_beneficiary_id: string | null;
  beneficiary_verified: boolean;
};

const toSupplier = (r: SupplierRow): Supplier => ({
  id: r.id,
  name: r.name,
  aliases: [],
  account: r.cashfree_beneficiary_id ? maskedAccount(r) : null,
  verified: r.beneficiary_verified && Boolean(r.cashfree_beneficiary_id),
});
