import type { ModelMessage } from "ai";

// What really happened in a turn, read from tool results rather than the model's words. A model
// can say "Ramesh ka 450 likh diya" without calling a tool; a receipt can't exist without one.

export type Action = { tool: string; output: Record<string, unknown> };

/** Statuses a write tool returns only after the change is saved. */
const DONE = new Set(["added", "recorded", "updated", "sent", "qr_ready", "payment_received", "remembered", "forgotten", "ordered", "alert_set", "paid", "payout_started", "pay_link", "tagged", "corrected", "removed"]);

/** True for a tool output that reports a saved change. */
function isDone(output: unknown): output is Record<string, unknown> {
  const status = (output as { status?: unknown } | null)?.status;
  return typeof status === "string" && DONE.has(status);
}

/** Write actions that succeeded in these messages. */
export function completedActions(messages: ModelMessage[]): Action[] {
  const actions: Action[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.output.type !== "json") continue;
      if (isDone(part.output.value)) actions.push({ tool: part.toolName, output: part.output.value });
    }
  }
  return actions;
}

/** A part of a chat (UI) message, as the web chat holds it: tool parts are typed "tool-<name>". */
export type MessagePart = { type: string; state?: string; output?: unknown };

/** The same, read from a web chat message's tool parts, including what ran after an approval. */
export function completedActionsInParts(parts: readonly MessagePart[]): Action[] {
  return parts.flatMap((part) =>
    part.type.startsWith("tool-") && part.state === "output-available" && isDone(part.output) ? [{ tool: part.type.slice("tool-".length), output: part.output }] : [],
  );
}

const s = (value: unknown) => (value === undefined || value === null ? "" : String(value));
const advanceNote = (output: Record<string, unknown>) => (output.advance ? ` (${s(output.advance)} advance)` : "");

/**
 * One line per saved change, built from the tool's output. Links, QRs and payment checks are
 * left out: the link, the QR image and the reply already show those.
 */
export function receiptLines(actions: Action[]): string[] {
  return actions.flatMap(({ tool, output }) => {
    switch (tool) {
      case "recordCredit":
        return [`🧾 Udhaar: ${s(output.customer)} ${s(output.amount)} · owes ${s(output.nowOwes)}${advanceNote(output)}`];
      case "recordPayment":
        return [`🧾 Payment: ${s(output.customer)} ${s(output.amount)} · owes ${s(output.nowOwes)}${advanceNote(output)}`];
      case "recordSale":
        return [`🧾 ${output.kind === "expense" ? "Expense" : "Sale"}: ${s(output.amount)}`];
      case "updateStock":
        return [`🧾 Stock: ${s(output.product)} now ${s(output.stock)}`];
      case "remember":
        return [`🧾 Remembered (${s(output.about)}): ${s(output.fact)}`];
      case "updateCustomer":
        return [`🧾 Customer: ${s(output.customer)}${output.previousName ? ` (was ${s(output.previousName)})` : ""}${output.phone ? ` · phone ${s(output.phone)}` : ""}`];
      case "forget":
        return ["🧾 Forgotten"];
      case "setReorderLevel":
        return [output.alertAt ? `🧾 Alert: ${s(output.product)} at ${s(output.alertAt)} (now ${s(output.stock)})` : `🧾 Alert removed: ${s(output.product)}`];
      case "setProductGst":
        return [`🧾 GST tag: ${s(output.product)} · HSN ${s(output.hsn)} · ${s(output.gst)}`];
      case "addProduct":
        return [`🧾 New product: ${s(output.product)} · ${s(output.stock)}`];
      case "correctEntry": {
        const owes = output.nowOwes ? ` · owes ${s(output.nowOwes)}${advanceNote(output)}` : "";
        return [
          output.status === "removed"
            ? `🧾 Removed: ${s(output.entry)} ${s(output.was)} (${s(output.recordedOn)})${owes}`
            : `🧾 Fixed: ${s(output.entry)} ${s(output.was)} → ${s(output.now)} (${s(output.recordedOn)})${owes}`,
        ];
      }
      case "tagAllProducts":
        return ((output.tagged ?? []) as Record<string, unknown>[]).map((t) => `🧾 GST tag: ${s(t.product)} · HSN ${s(t.hsn)} · ${s(t.gst)}`);
      case "paySupplier":
        return [
          output.status === "pay_link"
            ? `💸 Payment page for ${s(output.supplier)} ${s(output.amount)} · pay it and Cashfree sends it to ${s(output.to)}`
            : output.status === "paid"
            ? `💸 Paid ${s(output.supplier)} ${s(output.amount)} to ${s(output.to)} from your Cashfree balance${output.utr ? ` · UTR ${s(output.utr)}` : ""}`
            : `💸 Paying ${s(output.supplier)} ${s(output.amount)} to ${s(output.to)} from your Cashfree balance · started, Munshi will confirm`,
        ];
      case "placeSupplierOrder":
        return [`🚚 Order ${s(output.orderId)} to ${s(output.supplier)}: ${s(output.total)} · delivery ${s(output.deliverySlot)}${output.notSaved ? " · not saved in Munshi" : ""}`];
      case "addCustomer": {
        const customer = output.customer as { name?: string } | undefined;
        return [`🧾 New customer: ${s(customer?.name)}`];
      }
      default:
        return [];
    }
  });
}

// Past-tense "I saved / recorded / sent it", as owners and Munshi write it.
const CLAIMS = [
  /\b(recorded|saved|added|updated|noted down|logged|sent|reduced|deducted|increased)\b/i, // English
  /\b(likh|record|add|darj|save|update|jod|note|bhej|entry)\s*(kar\s*)?(diya|diye|di|liya|liye|ho\s*gaya|ho\s*gaye|ho\s*gayi|hua|hui)\b/i, // Hinglish
  // Stock changes: in testing the stock desk said "Sugar 5 kg stock kam kar diya" with no tool call.
  /\b(kam|ghata|ghat|badha|badh|kaat|hata|minus|plus)\s*(kar\s*)?(diya|diye|di|ho\s*gaya|ho\s*gaye|ho\s*gayi)\b/i, // Hinglish
  /\b(bardide|bareditini|bardidini|bardideeni|record\s*maadide|add\s*maadide|serisidini|serisidde|kalisidini|kalsidini|kammi\s*maadide|kadime\s*maadide|jaasti\s*maadide)\b/i, // Kannada in English letters
  /\b(ezhudhitten|ezhuthiten|potten|serthutten|record\s*panniten|anuppiten)\b/i, // Tamil in English letters
  /(लिख\s*(दिया|लिया|दिए)|दर्ज\s*(कर|हो)|जोड़\s*दिया|भेज\s*दिया|रिकॉर्ड\s*(कर|हो))/, // Hindi
  /(ಬರೆದ(ಿದ್ದೇನೆ|ಿದೆ|ೆ)|ಸೇರಿಸಿದ|ದಾಖಲಿಸಿದ|ಕಳುಹಿಸಿದ)/, // Kannada
  /(எழுதி(னேன்|விட்டேன்)|பதிவு\s*செய்த|சேர்த்த|அனுப்பின)/, // Tamil
];

/**
 * True when the reply says something was saved or sent, yet no write action succeeded. Not when a
 * tool found the same entry saved minutes ago: the reply then rightly says "yeh pehle record hui
 * thi, naya hai?" (live, that question got a false "Nothing was saved" warning).
 */
export function claimsUnbackedAction(reply: string, actions: Action[], repeatAsked = false): boolean {
  return !repeatAsked && actions.length === 0 && CLAIMS.some((pattern) => pattern.test(reply));
}

const isRepeat = (output: unknown) => (output as { status?: unknown } | null)?.status === "possible_repeat";

/** True when a tool in these messages found the entry already saved and asked the owner about it. */
export function askedAboutRepeat(messages: ModelMessage[]): boolean {
  return messages.some((m) => m.role === "tool" && m.content.some((part) => part.type === "tool-result" && part.output.type === "json" && isRepeat(part.output.value)));
}

/** The same, in a web chat message's tool parts. */
export function askedAboutRepeatInParts(parts: readonly MessagePart[]): boolean {
  return parts.some((part) => part.type.startsWith("tool-") && part.state === "output-available" && isRepeat(part.output));
}

/** The closing note for a retry after an unbacked claim. */
export const UNBACKED_CLAIM_NOTE =
  "Your last answer said something was recorded, saved or sent, but no tool did it in this turn. If the owner asked for a change, call the tool now. If not, don't say it was done.";

export const NOTHING_SAVED = "⚠️ Nothing was saved this time. Please check and ask again.";

/**
 * The closing note for a retry after an empty answer. Asked again with nothing new, the model
 * came back empty a second time (live: "Sorry, I couldn't put that into words").
 */
export const EMPTY_REPLY_NOTE =
  "Your last answer to the owner was empty. Reply now in one or two short sentences: do what they asked with a tool, or ask them a short question.";

// An owner message that reports money or goods changing hands: an amount and a verb of giving,
// taking, paying, selling or arriving. Live, "Ramesh ne 200 diye, ab kitna baaki hai?" got only
// the balance back, and nothing said the 200 was never written down.
const REPORTS = [
  /\b(diye|diya|de\s*diye|de\s*diya|liya|liye|le\s*gay[aie]|bhara|bhare|chukaya|chukaye|jama\s*kiy[ae]|bika|bike|bik\s*gay[aie]|aaya|aaye|aayi)\b/i, // Hinglish
  /\b(paid|pays|gave|took|received|bought|sold|arrived|came)\b/i, // English
  /\b(kottru|kottaru|kottidru|kottidaare|kotta|togondru|togondaru|togondidru|tagondru|bandide|bandvu|maaride)\b/i, // Kannada in English letters
  /\b(koduthaar|koduthanga|kuduthaar|kuduthanga|vaangunaar|vaanginaar|vaanginanga|vandhuchu|vithuchu|vitthuchu)\b/i, // Tamil in English letters
  /(दिए|दिया|लिया|लिए|भरा|भरे|चुकाए|जमा|बिका|बिके|आया|आए)/, // Hindi
  /(ಕೊಟ್ಟ|ತೊಗೊಂಡ|ತಗೊಂಡ|ಬಂದಿದೆ|ಮಾರಿದ)/, // Kannada
  /(கொடுத்த|வாங்கின|வந்த|விற்ற)/, // Tamil
];

/** True when the owner's message reads like an entry to record: an amount plus a reporting verb. */
export function reportsEntry(ownerText: string): boolean {
  return /\d/.test(ownerText) && REPORTS.some((pattern) => pattern.test(ownerText));
}

/**
 * True when the owner reported an entry, nothing was saved, and the reply doesn't ask about it.
 * No retry here on purpose: if the owner was asking about an old payment, a retry could record
 * it twice. The owner is told instead, and decides.
 */
export function missedEntry(ownerText: string, reply: string, actions: Action[]): boolean {
  return actions.length === 0 && reportsEntry(ownerText) && !reply.includes("?") && !reply.includes(NOTHING_SAVED);
}

export const NOT_RECORDED = "📝 Nothing was recorded from this message. If it was a new entry, say \"record it\".";

/** What goes under a reply, the same on every channel: receipts, then at most one warning. */
export type ReplyFooter = { receipts: string[]; notice: typeof NOTHING_SAVED | typeof NOT_RECORDED | null };

/**
 * Receipts for what was saved, and a warning when the reply claims a change no tool made, or the
 * owner reported an entry and nothing was saved. No warning while an approval is waiting: the
 * turn isn't over, and the approval card already says nothing has happened yet.
 */
export function replyFooter(turn: { ownerText: string; reply: string; actions: Action[]; awaitingApproval: boolean; repeatAsked?: boolean }): ReplyFooter {
  const receipts = receiptLines(turn.actions);
  if (turn.awaitingApproval || turn.reply.includes(NOTHING_SAVED)) return { receipts, notice: null };
  if (claimsUnbackedAction(turn.reply, turn.actions, turn.repeatAsked)) return { receipts, notice: NOTHING_SAVED };
  if (missedEntry(turn.ownerText, turn.reply, turn.actions)) return { receipts, notice: NOT_RECORDED };
  return { receipts, notice: null };
}
