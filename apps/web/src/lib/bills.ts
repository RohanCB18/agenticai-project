import "server-only";
import {
  type Bill,
  billGstSummary,
  billLineGstTag,
  BillReadError,
  billSummary,
  checkBill,
  compareBillGst,
  type KnowledgeBase,
  type OfficialRates,
  officialRatesByHsn,
  overchargeLine,
  type PlannedItem,
  planBill,
  readBill,
} from "@munshi/agents";
import { rupeesToPaise } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSender, MessagingChannel } from "@/lib/channels/types";
import { configuredKnowledge } from "@/lib/knowledge";

/** The GST check is extra: past this, the bill goes to the owner without it. */
const GST_CHECK_TIMEOUT_MS = 12_000;

// Bill photos run outside the agent on purpose: bill text is untrusted, so it goes through this
// code and the owner's buttons instead of the model's prompt.

/** Approval ids for bills, so a tap can be told apart from an agent tool approval. */
export const BILL_APPROVAL_PREFIX = "bill-";

const CLEARER_PHOTO = "I couldn't read that bill. Please send a clearer photo of the whole bill, in good light.";

type BillPhoto = { chatId: string; channel: MessagingChannel; merchantId: string; image: Blob; filename: string };

/** Reads a bill photo, saves it as pending and asks the owner to approve it. */
export async function handleBillPhoto(db: SupabaseClient, sender: ChannelSender, photo: BillPhoto) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY is missing");
  const { chatId, channel, merchantId } = photo;

  await sender.showWorking?.(chatId, "typing");
  let bill: Bill;
  try {
    bill = await readBill({ apiKey, image: photo.image, filename: photo.filename });
  } catch (error) {
    if (!(error instanceof BillReadError)) throw error;
    console.warn("[munshi] bill read failed:", error.message);
    return sender.sendText(chatId, CLEARER_PHOTO);
  }
  if (bill.items.length === 0) return sender.sendText(chatId, CLEARER_PHOTO);

  const { data: products } = await db.from("products").select("id, name, aliases, stock_qty").eq("merchant_id", merchantId);
  const items = planBill(
    bill,
    (products ?? []).map((p) => ({ id: p.id as string, name: p.name as string, aliases: p.aliases as string[], stockQty: Number(p.stock_qty) })),
  );

  const warnings = checkBill(bill);
  // In live testing a duplicate was approved with one tap despite a warning at the bottom, so a
  // repeat bill leads with the warning and its button says what it really does.
  const [duplicate, official] = await Promise.all([alreadyApplied(db, merchantId, bill), lookUpHsnCodes(bill, configuredKnowledge())]);
  if (duplicate) warnings.unshift(DUPLICATE_WARNING);
  const gst = official ? compareBillGst(bill, official) : null;
  // Kept with the bill too, so an overcharge can be raised with the supplier later.
  const gstWarnings = gst?.status === "checked" ? gst.overcharged.map((o) => `GST: ${overchargeLine(o)}`) : [];

  const { data: saved, error } = await db
    .from("bills")
    .insert({
      merchant_id: merchantId,
      supplier_name: bill.supplierName,
      bill_number: bill.billNumber,
      bill_date: bill.billDate,
      total_paise: bill.total === null ? null : rupeesToPaise(bill.total),
      items: items.map((item) => toStoredItem(item, official)),
      warnings: [...warnings, ...gstWarnings],
      source: channel,
    })
    .select("id")
    .single();
  if (error || !saved) throw new Error(`Save bill failed: ${error?.message}`);

  const summary = billSummary(bill, items, warnings, billGstSummary(gst, bill.supplierName));
  await sender.sendApproval(
    chatId,
    duplicate ? `⚠️ ALREADY ADDED: you added this bill before. Adding it again doubles the stock.\n\n${summary}` : summary,
    `${BILL_APPROVAL_PREFIX}${saved.id}`,
    duplicate ? { yes: "⚠️ Add again anyway", no: "✅ Don't add" } : { yes: "✅ Add to stock", no: "❌ Nahi" },
  );
}

const DUPLICATE_WARNING = "This bill looks already added. Adding it again would double the stock.";

/**
 * A bill line as stored. `gst_official` (with its citation) is set only when the official entries
 * for the line's HSN code agree on one rate: apply_bill copies it to a product with no tag yet.
 */
function toStoredItem(item: PlannedItem, official: Record<string, OfficialRates> | null) {
  const tag = billLineGstTag(item.hsn, official, item.gstRate ?? null);
  return {
    name: item.name,
    quantity: item.quantity,
    unit: item.unit,
    rate: item.rate,
    amount: item.amount,
    product_id: item.productId,
    hsn: item.hsn ?? null,
    gst_rate: item.gstRate ?? null,
    gst_official: tag.gstRate,
    gst_citation: tag.citation,
  };
}

/**
 * The official rates for the bill's HSN codes, or null when they can't be looked up in time. A
 * failed lookup never holds up the bill: the owner still gets it to approve, just without the
 * GST note, and its products aren't tagged.
 */
async function lookUpHsnCodes(bill: Bill, knowledge: KnowledgeBase | undefined): Promise<Record<string, OfficialRates> | null> {
  if (!knowledge || !bill.items.some((item) => item.hsn)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), GST_CHECK_TIMEOUT_MS)));
  try {
    const result = await Promise.race([officialRatesByHsn(bill, knowledge), timeout]);
    if (result === null) console.warn("[munshi] bill HSN lookup timed out");
    return result;
  } catch (error) {
    console.warn("[munshi] bill HSN lookup failed:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function alreadyApplied(db: SupabaseClient, merchantId: string, bill: Bill) {
  if (!bill.billNumber || !bill.supplierName) return false;
  const { data } = await db
    .from("bills")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("status", "applied")
    .eq("bill_number", bill.billNumber)
    .ilike("supplier_name", bill.supplierName)
    .limit(1);
  return Boolean(data?.length);
}

/** The owner's answer to a bill. Returns the message to send back. */
export async function decideBill(db: SupabaseClient, merchantId: string, billId: string, approved: boolean) {
  if (!approved) {
    const { data } = await db
      .from("bills")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", billId)
      .eq("merchant_id", merchantId)
      .eq("status", "pending")
      .select("id");
    return data?.length ? "Okay, nothing was added to stock." : "That bill was already handled.";
  }

  // One transaction in the database, so a double tap can't add the stock twice.
  const { data: newProducts, error } = await db.rpc("apply_bill", { p_bill_id: billId, p_merchant_id: merchantId });
  if (error) throw new Error(`Apply bill failed: ${error.message}`);
  if (newProducts === -1) return "That bill was already handled.";
  return newProducts > 0 ? `✅ Stock updated. ${newProducts} new item${newProducts === 1 ? "" : "s"} added to your list.` : "✅ Stock updated.";
}
