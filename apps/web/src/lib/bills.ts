import "server-only";
import { type Bill, BillReadError, billSummary, checkBill, type PlannedItem, planBill, readBill } from "@munshi/agents";
import { rupeesToPaise } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSender, MessagingChannel } from "@/lib/channels/types";

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
  if (await alreadyApplied(db, merchantId, bill)) warnings.unshift("This bill looks already added. Adding it again would double the stock.");

  const { data: saved, error } = await db
    .from("bills")
    .insert({
      merchant_id: merchantId,
      supplier_name: bill.supplierName,
      bill_number: bill.billNumber,
      bill_date: bill.billDate,
      total_paise: bill.total === null ? null : rupeesToPaise(bill.total),
      items: items.map(toStoredItem),
      warnings,
      source: channel,
    })
    .select("id")
    .single();
  if (error || !saved) throw new Error(`Save bill failed: ${error?.message}`);

  await sender.sendApproval(chatId, billSummary(bill, items, warnings), `${BILL_APPROVAL_PREFIX}${saved.id}`, { yes: "✅ Add to stock", no: "❌ Nahi" });
}

function toStoredItem(item: PlannedItem) {
  return { name: item.name, quantity: item.quantity, unit: item.unit, rate: item.rate, amount: item.amount, product_id: item.productId };
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
