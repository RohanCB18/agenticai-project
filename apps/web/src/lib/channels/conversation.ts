import "server-only";
import {
  approvalResponse,
  claimsUnbackedAction,
  EMPTY_REPLY_NOTE,
  missedEntry,
  NOT_RECORDED,
  closePendingApprovals,
  completedActions,
  NOTHING_SAVED,
  receiptLines,
  UNBACKED_CLAIM_NOTE,
  type PendingApproval,
  pendingApprovals,
  SARVAM_LANGUAGE,
  synthesize,
  toolOutputs,
  transcribe,
  trimThread,
} from "@munshi/agents";
import { formatINR, type Language, rupeesToPaise } from "@munshi/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelMessage } from "ai";
import { buildKhataAgent } from "@/lib/agent";
import { BILL_APPROVAL_PREFIX, decideBill, handleBillPhoto } from "@/lib/bills";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChannelSender, Inbound, LinkButton, MessagingChannel } from "./types";

const APP_NAME: Record<MessagingChannel, string> = { telegram: "Telegram", whatsapp: "WhatsApp" };

const notLinked = (channel: MessagingChannel) =>
  `Namaste! This chat isn't linked to a Munshi shop yet. Open Munshi → Dashboard → Connect ${APP_NAME[channel]}.`;

const HELP =
  'Send me a voice note or a text in any language, like "Ramesh ne 450 ka saaman liya", "Fatima ne 200 diye" or "Kaun kaun udhaar pe hai?" You can also send a photo of a supplier bill to update your stock.';

/**
 * Handles one incoming chat message on any messaging channel. Runs after the webhook has
 * answered the platform, using the admin client: there is no browser session, so the
 * linked chat account is the identity. Every khata query is still scoped to its merchant.
 */
export async function handleInbound(inbound: Inbound, sender: ChannelSender) {
  const admin = createAdminClient();
  const { channel, chatId } = inbound;

  // Platforms retry webhooks: process each update once.
  const { error: duplicate } = await admin.from("inbound_updates").insert({ channel, external_id: inbound.updateId });
  if (duplicate) {
    if (duplicate.code === "23505") return;
    throw new Error(`Dedupe failed: ${duplicate.message}`);
  }

  if (inbound.kind === "link") return linkAccount(admin, inbound, sender);

  const { data: link } = await admin.from("channel_links").select("merchant_id").eq("channel", channel).eq("external_user_id", chatId).maybeSingle();
  if (!link) {
    if (inbound.kind === "decision") await inbound.acknowledge?.("stale");
    return sender.sendText(chatId, notLinked(channel));
  }

  const { data: merchant, error } = await admin.from("merchants").select("id, shop_name, preferred_language").eq("id", link.merchant_id).single();
  if (error || !merchant) throw new Error(`Linked merchant missing: ${error?.message}`);
  const language = merchant.preferred_language as Language;

  // Bills skip the agent entirely: their text is untrusted, so it must not reach the prompt.
  if (inbound.kind === "image") {
    return handleBillPhoto(admin, sender, { chatId, channel, merchantId: merchant.id, image: await inbound.download(), filename: inbound.filename });
  }
  if (inbound.kind === "decision" && inbound.approvalId.startsWith(BILL_APPROVAL_PREFIX)) {
    const billId = inbound.approvalId.slice(BILL_APPROVAL_PREFIX.length);
    await inbound.acknowledge?.(inbound.approved ? "approved" : "denied");
    return sender.sendText(chatId, await decideBill(admin, merchant.id, billId, inbound.approved));
  }

  const { data: thread } = await admin.from("agent_threads").select("messages").eq("merchant_id", merchant.id).eq("channel", channel).maybeSingle();
  let messages = (thread?.messages ?? []) as ModelMessage[];
  let ownerText = ""; // what the owner said this turn, if they said anything
  let replyLanguage: string | null = null; // set for voice notes: Munshi answers by voice too

  if (inbound.kind === "decision") {
    const pending = pendingApprovals(messages).find((p) => p.approvalId === inbound.approvalId);
    if (!pending) {
      await inbound.acknowledge?.("stale");
      return sender.sendText(chatId, "That request was already handled.");
    }
    await inbound.acknowledge?.(inbound.approved ? "approved" : "denied");
    messages = [...messages, approvalResponse(pending.approvalId, inbound.approved)];
  } else {
    let text = "";
    if (inbound.kind === "text") {
      text = inbound.text.trim();
      if (/^\/(start|help)\b/i.test(text)) return sender.sendText(chatId, `Munshi is ready for ${merchant.shop_name}. ${HELP}`);
    } else if (inbound.kind === "voice") {
      const apiKey = process.env.SARVAM_API_KEY;
      if (!apiKey) throw new Error("SARVAM_API_KEY is missing");
      await sender.showWorking?.(chatId, "typing");
      const heard = await transcribe({ apiKey, audio: await inbound.download(), filename: inbound.filename, keyterms: await shopKeyterms(admin, merchant.id) });
      text = heard.transcript;
      replyLanguage = heard.languageCode ?? SARVAM_LANGUAGE[language];
      if (!text) return sender.sendText(chatId, "Couldn't hear that clearly. Please send the voice note again.");
      await sender.sendText(chatId, `🎤 ${text}`); // show what Munshi heard, so a mishearing is easy to spot
    } else {
      return sender.sendText(chatId, `I understand texts, voice notes and photos of bills. ${HELP}`);
    }
    if (!text) return;
    ownerText = text;
    messages = [...closePendingApprovals(messages), { role: "user", content: text }];
  }

  await sender.showWorking?.(chatId, "typing");
  const agentFor = (extraNote?: string) =>
    buildKhataAgent({ db: admin, merchant: { id: merchant.id, shopName: merchant.shop_name, language }, source: channel, channel, extraNote });
  const agent = agentFor();
  const result = await agent.generate({ messages });
  console.info(`[munshi] ${channel} run: ${runSummary(result)}`);
  let responseMessages = result.responseMessages;
  let text = result.text.trim();

  // A reply that says "likh diya" with no tool behind it: try once more from the owner's
  // message, told what went wrong. If it still claims without acting, say so plainly.
  if (claimsUnbackedAction(text, completedActions(responseMessages))) {
    console.warn("[munshi] reply claimed an action no tool took; retrying:", text);
    const retry = await agentFor(UNBACKED_CLAIM_NOTE).generate({ messages });
    console.info(`[munshi] ${channel} retry run: ${runSummary(retry)}`);
    responseMessages = retry.responseMessages;
    text = retry.text.trim();
    if (claimsUnbackedAction(text, completedActions(responseMessages))) text = `${text}\n\n${NOTHING_SAVED}`;
  }
  // The model sometimes ends with no words at all. Give it one more turn with any tool results in
  // hand, told its answer was empty: asked again with nothing new, it came back empty again.
  if (!text && pendingApprovals([...messages, ...responseMessages]).length === 0) {
    const retry = await agentFor(EMPTY_REPLY_NOTE).generate({ messages: [...messages, ...responseMessages] });
    console.warn(`[munshi] ${channel} empty reply; asked again: ${runSummary(retry)}`);
    responseMessages = [...responseMessages, ...retry.responseMessages];
    text = retry.text.trim() || "Sorry, I couldn't put that into words. Please ask again.";
  }
  messages = trimThread([...messages, ...responseMessages]);
  await admin.from("agent_threads").upsert({ merchant_id: merchant.id, channel, messages, updated_at: new Date().toISOString() });

  // New payment links: make sure the owner gets the link, with a button to pass it on.
  // Receipts come from the tools' own output, so the owner can tell what was really saved.
  const receipts = receiptLines(completedActions(responseMessages));
  let reply = receipts.length && text ? `${text}\n\n${receipts.join("\n")}` : text;
  // The owner said money or goods changed hands, nothing was saved, and the reply doesn't ask why.
  if (pendingApprovals(messages).length === 0 && missedEntry(ownerText, text, completedActions(responseMessages))) {
    console.warn("[munshi] owner reported an entry but nothing was recorded:", ownerText);
    reply = `${reply}\n\n${NOT_RECORDED}`;
  }
  const buttons: LinkButton[] = [];
  for (const output of toolOutputs(responseMessages, "sendPaymentLink")) {
    const out = output as { status?: string; url?: string; customer?: string; amount?: string };
    if (out.status !== "sent" || !out.url) continue;
    if (!reply.includes(out.url)) reply += `\n\nUPI link: ${out.url}`;
    const phone = await customerPhone(admin, merchant.id, out.customer);
    const note = `Namaste ${out.customer ?? ""}, ${merchant.shop_name} ka ${out.amount ?? ""} baaki hai. UPI se yahan pay karein: ${out.url}`;
    buttons.push({ text: `Send to ${out.customer ?? "customer"} on WhatsApp`, url: `https://wa.me/${phone ?? ""}?text=${encodeURIComponent(note)}` });
  }

  // In-shop QRs go out as an image, before the reply, so the customer can scan straight away.
  for (const output of toolOutputs(responseMessages, "showPaymentQr")) {
    const out = output as { status?: string; qrId?: string; customer?: string; amount?: string };
    if (out.status !== "qr_ready" || !out.qrId) continue;
    const { data: qr } = await admin.from("payment_qrs").select("qr_png").eq("id", out.qrId).eq("merchant_id", merchant.id).single();
    if (qr) await sender.sendPhoto(chatId, Uint8Array.from(Buffer.from(qr.qr_png, "base64")), `${out.customer ?? "Customer"}: ${out.amount ?? ""}. Scan with any UPI app.`);
  }

  if (reply) {
    await sender.sendText(chatId, reply, buttons);
    // Speak the answer only: receipts and links are for reading.
    if (replyLanguage && text) await speakReply(sender, chatId, text, replyLanguage);
  }
  for (const approval of pendingApprovals(messages)) {
    await sender.sendApproval(chatId, approvalPrompt(approval), approval.approvalId);
  }
}

async function linkAccount(admin: SupabaseClient, inbound: Inbound & { kind: "link" }, sender: ChannelSender) {
  const { channel, chatId } = inbound;
  const { data: row } = await admin.from("channel_link_codes").select("merchant_id, expires_at").eq("code", inbound.code).eq("channel", channel).maybeSingle();
  if (!row || new Date(row.expires_at) < new Date()) {
    return sender.sendText(chatId, `That link has expired. Open Munshi → Dashboard → Connect ${APP_NAME[channel]} for a fresh one.`);
  }

  // One account per shop and one shop per account: replace any earlier link on either side.
  await admin.from("channel_links").delete().eq("channel", channel).eq("merchant_id", row.merchant_id);
  await admin.from("channel_links").delete().eq("channel", channel).eq("external_user_id", chatId);
  const { error } = await admin
    .from("channel_links")
    .insert({ merchant_id: row.merchant_id, channel, external_user_id: chatId, profile_name: inbound.profileName ?? null });
  if (error) throw new Error(`Link failed: ${error.message}`);
  await admin.from("channel_link_codes").delete().eq("merchant_id", row.merchant_id).eq("channel", channel);
  await admin.from("agent_threads").delete().eq("merchant_id", row.merchant_id).eq("channel", channel);

  const { data: merchant } = await admin.from("merchants").select("shop_name").eq("id", row.merchant_id).single();
  await sender.sendText(chatId, `✅ Linked to ${merchant?.shop_name ?? "your shop"}.\n\n${HELP}`);
}

/** One log line per model run: steps, tools in order, how it ended. Enough to debug from Vercel's logs. */
function runSummary(run: { steps: { toolCalls: { toolName: string }[] }[]; finishReason: string; text: string }) {
  const tools = run.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
  return `${run.steps.length} steps, tools ${tools.join(" > ") || "none"}, finished ${run.finishReason}, ${run.text.trim().length} chars`;
}

/** Customer and product names bias speech recognition toward this shop's vocabulary. */
async function shopKeyterms(admin: SupabaseClient, merchantId: string) {
  const [customers, products] = await Promise.all([
    admin.from("customers").select("name, aliases").eq("merchant_id", merchantId),
    admin.from("products").select("name, aliases").eq("merchant_id", merchantId),
  ]);
  return [...(customers.data ?? []), ...(products.data ?? [])].flatMap((r) => [r.name as string, ...((r.aliases as string[]) ?? [])]);
}

async function customerPhone(admin: SupabaseClient, merchantId: string, name?: string) {
  if (!name) return null;
  const { data } = await admin.from("customers").select("phone").eq("merchant_id", merchantId).eq("name", name).limit(1).maybeSingle();
  return data?.phone ? data.phone.replace(/\D/g, "") : null;
}

async function speakReply(sender: ChannelSender, chatId: string, text: string, languageCode: string) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return;
  try {
    await sender.showWorking?.(chatId, "voice");
    const mp3 = await synthesize({
      apiKey,
      text,
      languageCode,
      codec: "mp3",
      model: process.env.SARVAM_TTS_MODEL || undefined,
      speaker: process.env.SARVAM_TTS_SPEAKER || undefined,
    });
    await sender.sendVoice(chatId, mp3);
  } catch (error) {
    // The text reply already went out; a missing voice reply shouldn't fail the turn.
    console.error("[munshi] voice reply failed:", error);
  }
}

function approvalPrompt(approval: PendingApproval) {
  if (approval.toolName === "sendPaymentLink") {
    const { customerName, amount } = (approval.input ?? {}) as { customerName?: string; amount?: number };
    const what = amount ? formatINR(rupeesToPaise(amount)) : "their full balance";
    return `🔐 Needs your OK\n\nSend ${customerName ?? "the customer"} a UPI payment link for ${what}?`;
  }
  return `🔐 Needs your OK: ${approval.toolName}`;
}
