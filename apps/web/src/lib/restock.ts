import "server-only";
import {
  type KhataStore,
  lowProducts,
  readQuote,
  restockAlert,
  restockItems,
  restockOrdered,
  type Supplier,
  type SupplierAgent,
  type SupplierOrder,
  type SupplierQuote,
} from "@munshi/agents";
import type { SupabaseClient } from "@supabase/supabase-js";
import { telegramSender } from "@/lib/channels/telegram";
import type { ApprovalLabels, LinkButton, MessagingChannel } from "@/lib/channels/types";
import { whatsappSender } from "@/lib/channels/whatsapp";
import { payoutsConfigured } from "@/lib/cashfree-payouts";
import { createSupabaseKhataStore } from "@/lib/khata-store";
import { configuredSupplier } from "@/lib/supplier";

// Restocking on Munshi's own initiative, end to end. When something falls to the alert level the
// owner set, Munshi asks once on their chat app with the wholesaler's signed quote; one "haan"
// places exactly that order and pays the supplier from the shop's Cashfree balance (Payouts), or,
// when the balance can't, sends a Cashfree page to pay (Easy Split). Asked again for the same
// product only after 3 days, so a low item doesn't nag after every message.
//
// Each ask is a row in `approvals` (action purchase_order, payload.kind "restock"): pending until
// the owner taps, then executed, rejected, failed or expired, like the other approvals.

export const RESTOCK_APPROVAL_PREFIX = "rst-";
const ASK_AGAIN_AFTER_MS = 3 * 24 * 60 * 60_000;

export type RestockRequest = { id: string; quoteId: string | null; expiresAt: string };

/** Where restock asks are kept. */
export interface RestockBook {
  /** Products asked about since then, except on a quote that ran out before the owner answered. */
  askedSince(since: Date): Promise<Set<string>>;
  open(request: { productIds: string[]; quoteId: string | null; totalPaise: number | null; summary: string; expiresAt: Date; offered: boolean }): Promise<string>;
  /** The ask, if it is still waiting for the owner. */
  pending(id: string): Promise<RestockRequest | null>;
  /** Waiting → approved. False when it was answered already (a double tap). */
  claim(id: string): Promise<boolean>;
  close(id: string, status: "rejected" | "executed" | "failed" | "expired", note?: Record<string, unknown>): Promise<void>;
}

/** The owner's linked chat apps. */
export interface OwnerChats {
  readonly count: number;
  ask(text: string, approvalId: string, labels: ApprovalLabels): Promise<void>;
  tell(text: string, buttons?: LinkButton[]): Promise<void>;
}

/** `fromBalance`: Cashfree Payouts is set up, so a "haan" pays from the shop's balance. */
export type RestockDeps = { store: KhataStore; book: RestockBook; chats: OwnerChats; supplier?: SupplierAgent; shopName: string; fromBalance?: boolean; now?: Date };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The supplier Munshi can pay for this wholesaler: one the owner added and confirmed. */
async function payeeFor(store: KhataStore, wholesaler: string): Promise<Supplier | undefined> {
  return (await store.listSuppliers()).find((s) => s.verified && s.account && sameName(s.name, wholesaler));
}

/**
 * Asks the owner about anything newly low, with the wholesaler's quote and a Haan button when it
 * can be ordered. "none" when there is nothing new to ask or nowhere to ask it.
 */
export async function askToRestock({ store, book, chats, supplier, shopName, fromBalance = false, now = new Date() }: RestockDeps): Promise<"none" | "asked" | "told"> {
  if (chats.count === 0) return "none";
  const low = lowProducts(await store.listProducts());
  if (low.length === 0) return "none";
  const asked = await book.askedSince(new Date(now.getTime() - ASK_AGAIN_AFTER_MS));
  const fresh = low.filter((p) => !asked.has(p.id));
  if (fresh.length === 0) return "none";

  let quote: SupplierQuote | null = null;
  let problem: string | undefined;
  if (supplier) {
    try {
      quote = await supplier.quote(restockItems(fresh), shopName);
    } catch (error) {
      console.warn("[munshi] restock quote failed:", error instanceof Error ? error.message : error);
      problem = `${supplier.name} didn't answer just now, so there's no quote yet. Say "jo khatam ho raha hai uska order do" to try again.`;
    }
  }
  const payee = quote ? await payeeFor(store, quote.supplier) : undefined;
  const { text, canOrder } = restockAlert(fresh, quote, payee ? { to: payee.account!, fromBalance } : null, problem);
  const id = await book.open({
    productIds: fresh.map((p) => p.id),
    quoteId: canOrder ? quote!.quoteId! : null,
    totalPaise: canOrder ? quote!.totalPaise : null,
    summary: canOrder ? `Restock from ${quote!.supplier}: ${quote!.total}` : `Running low: ${fresh.map((p) => p.name).join(", ")}`,
    expiresAt: quote?.validUntil ? new Date(quote.validUntil) : new Date(now.getTime() + 24 * 60 * 60_000),
    offered: canOrder,
  });
  console.info(`[munshi] restock ask ${id}: ${fresh.length} low, ${canOrder ? `quote ${quote!.total}` : "nothing to order"}`);
  if (!canOrder) {
    await chats.tell(text);
    return "told";
  }
  await chats.ask(text, `${RESTOCK_APPROVAL_PREFIX}${id}`, { yes: payee ? "✅ Haan, order + pay" : "✅ Haan, order karo", no: "❌ Nahi" });
  return "asked";
}

/** `paying`: a transfer from the balance is on its way, so the caller watches it to say when it lands. */
export type RestockAnswer = { text: string; buttons?: LinkButton[]; askAgain?: boolean; paying?: boolean };

/**
 * The owner's tap on a restock ask. "Haan" orders exactly the quote they were shown and, when the
 * supplier's account is set up, pays for it: from the Cashfree balance, or with a page to pay when
 * the balance can't. No further question.
 */
export async function answerRestock({ store, book, supplier, now = new Date() }: Omit<RestockDeps, "chats" | "shopName">, approvalId: string, approved: boolean): Promise<RestockAnswer> {
  const id = approvalId.slice(RESTOCK_APPROVAL_PREFIX.length);
  const request = await book.pending(id);
  if (!request) return { text: "That restock request was already answered or has expired." };
  if (!approved) {
    await book.close(id, "rejected");
    return { text: "Okay, not ordering. If it's still low, I'll ask again in 3 days." };
  }
  const quote = request.quoteId ? readQuote(request.quoteId) : null;
  if (!request.quoteId || !quote || quote.expiresAt <= now) {
    await book.close(id, "expired", { quoteExpired: true });
    return { text: "That quote has expired, so nothing was ordered. Here's a fresh one.", askAgain: true };
  }
  if (!supplier) {
    await book.close(id, "failed", { error: "no wholesaler connected" });
    return { text: "No wholesaler is connected to Munshi now, so nothing was ordered." };
  }
  if (!(await book.claim(id))) return { text: "That restock request was already answered." };

  let order: SupplierOrder;
  try {
    order = await supplier.order(request.quoteId);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    await book.close(id, "failed", { error: why.slice(0, 300) });
    return { text: `${supplier.name} didn't take the order (${why}). Nothing was ordered or paid.` };
  }
  // The wholesaler has the order now: a failure to keep our copy mustn't read as "not ordered".
  try {
    await store.saveSupplierOrder({ ...order, quoteId: request.quoteId });
  } catch (error) {
    console.error("[munshi] restock order placed but not saved:", error instanceof Error ? error.message : error);
  }
  await book.close(id, "executed", { orderId: order.orderId });
  await store.audit("restock_ordered", { approvalId: id, orderId: order.orderId, totalPaise: order.totalPaise });

  const payee = await payeeFor(store, order.supplier);
  if (!payee) return { text: restockOrdered(order, null) };
  try {
    const due = (await store.unpaidSupplierOrders(payee.name)).find((o) => o.orderRef === order.orderId);
    const payout = await store.paySupplier({ supplier: payee, amountPaise: order.totalPaise, supplierOrderId: due?.id });
    const to = payee.account!;
    if (payout.status === "success") return { text: restockOrdered(order, { status: "paid", to, utr: payout.utr }) };
    if (payout.status === "pending" && payout.paymentUrl) {
      return {
        text: restockOrdered(order, { status: "page", url: payout.paymentUrl, to, because: payout.reason }),
        buttons: [{ text: `Pay ${order.total} to ${order.supplier}`, url: payout.paymentUrl }],
      };
    }
    if (payout.status === "pending") return { text: restockOrdered(order, { status: "started", to }), paying: true };
    return { text: restockOrdered(order, { status: "failed", error: payout.reason ?? "Cashfree didn't pay it" }) };
  } catch (error) {
    console.error("[munshi] restock payment failed:", error instanceof Error ? error.message : error);
    return { text: restockOrdered(order, { status: "failed", error: "Cashfree didn't take the payment" }) };
  }
}

// ---------------------------------------------------------------- the database and chat apps

export function supabaseRestockBook(admin: SupabaseClient, merchantId: string): RestockBook {
  const rows = () => admin.from("approvals").select("id, payload, expires_at").eq("merchant_id", merchantId).eq("action", "purchase_order");
  type Row = { id: string; payload: { kind?: string; productIds?: string[]; quoteId?: string | null; quoteExpired?: boolean } | null; expires_at: string };
  return {
    async askedSince(since) {
      const { data, error } = await rows().gte("created_at", since.toISOString());
      if (error) throw new Error(`Read restock asks failed: ${error.message}`);
      const asked = new Set<string>();
      for (const row of (data ?? []) as Row[]) {
        if (row.payload?.kind !== "restock" || row.payload.quoteExpired) continue;
        for (const id of row.payload.productIds ?? []) asked.add(id);
      }
      return asked;
    },
    async open({ productIds, quoteId, totalPaise, summary, expiresAt, offered }) {
      const { data, error } = await admin
        .from("approvals")
        .insert({
          merchant_id: merchantId,
          action: "purchase_order",
          // An ask with nothing to order is a notice: it is kept only so the product isn't asked about again.
          status: offered ? "pending" : "expired",
          summary,
          payload: { kind: "restock", productIds, quoteId },
          amount_paise: totalPaise,
          requested_by: "restock",
          expires_at: expiresAt.toISOString(),
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`Save restock ask failed: ${error?.message}`);
      return data.id as string;
    },
    async pending(id) {
      const { data } = await rows().eq("id", id).eq("status", "pending").maybeSingle();
      const row = data as Row | null;
      if (!row || row.payload?.kind !== "restock") return null;
      return { id: row.id, quoteId: row.payload.quoteId ?? null, expiresAt: row.expires_at };
    },
    async claim(id) {
      const { data } = await admin
        .from("approvals")
        .update({ status: "approved", decided_at: new Date().toISOString() })
        .eq("id", id)
        .eq("merchant_id", merchantId)
        .eq("status", "pending")
        .select("id");
      return (data ?? []).length > 0;
    },
    async close(id, status, note) {
      const { data } = await rows().eq("id", id).maybeSingle();
      const payload = { ...((data as Row | null)?.payload ?? {}), ...note };
      await admin
        .from("approvals")
        .update({ status, payload, ...(status === "rejected" ? { decided_at: new Date().toISOString() } : {}) })
        .eq("id", id)
        .eq("merchant_id", merchantId);
    },
  };
}

const SENDERS = { telegram: telegramSender, whatsapp: whatsappSender };

export async function linkedChats(admin: SupabaseClient, merchantId: string): Promise<OwnerChats> {
  const { data } = await admin.from("channel_links").select("channel, external_user_id").eq("merchant_id", merchantId);
  const links = (data ?? []) as { channel: MessagingChannel; external_user_id: string }[];
  const each = async (send: (link: (typeof links)[number]) => Promise<void>) => {
    for (const link of links) await send(link).catch((error: unknown) => console.error("[munshi] restock message failed:", error));
  };
  return {
    count: links.length,
    ask: (text, approvalId, labels) => each((l) => SENDERS[l.channel].sendApproval(l.external_user_id, text, approvalId, labels)),
    tell: (text, buttons) => each((l) => SENDERS[l.channel].sendText(l.external_user_id, text, buttons)),
  };
}

function storeFor(admin: SupabaseClient, merchantId: string) {
  return createSupabaseKhataStore(admin, merchantId, { source: "telegram", actor: "restock" });
}

/** After a turn, and every evening: asks about anything newly low. Never throws. */
export async function alertLowStock(admin: SupabaseClient, merchantId: string) {
  try {
    const chats = await linkedChats(admin, merchantId);
    if (chats.count === 0) return "none";
    const { data: shop } = await admin.from("merchants").select("shop_name").eq("id", merchantId).single();
    return await askToRestock({
      store: storeFor(admin, merchantId),
      book: supabaseRestockBook(admin, merchantId),
      chats,
      supplier: configuredSupplier(),
      shopName: shop?.shop_name ?? "Shop",
      fromBalance: payoutsConfigured(),
    });
  } catch (error) {
    console.error("[munshi] low-stock check failed:", error instanceof Error ? error.message : error);
    return "none";
  }
}

/**
 * The restock ask a plain typed or spoken "haan" or "nahi" answers: the newest one still waiting,
 * if Munshi sent it after the chat's last reply (else the owner is answering that reply instead).
 * Its id with the prefix, as a tap would send it, or null.
 */
export async function pendingRestockAsk(admin: SupabaseClient, merchantId: string, after: Date | null): Promise<string | null> {
  let query = admin
    .from("approvals")
    .select("id, payload")
    .eq("merchant_id", merchantId)
    .eq("action", "purchase_order")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  if (after) query = query.gt("created_at", after.toISOString());
  const { data, error } = await query.order("created_at", { ascending: false }).limit(5);
  if (error) throw new Error(`Read restock asks failed: ${error.message}`);
  const ask = ((data ?? []) as { id: string; payload: { kind?: string } | null }[]).find((row) => row.payload?.kind === "restock");
  return ask ? `${RESTOCK_APPROVAL_PREFIX}${ask.id}` : null;
}

/** The owner tapped Haan or Nahi on a restock ask, or said it. */
export function decideRestock(admin: SupabaseClient, merchantId: string, approvalId: string, approved: boolean) {
  return answerRestock({ store: storeFor(admin, merchantId), book: supabaseRestockBook(admin, merchantId), supplier: configuredSupplier() }, approvalId, approved);
}
