import type { ModelMessage } from "ai";

// What really happened in a turn, read from tool results rather than the model's words. A model
// can say "Ramesh ka 450 likh diya" without calling a tool; a receipt can't exist without one.

export type Action = { tool: string; output: Record<string, unknown> };

/** Statuses a write tool returns only after the change is saved. */
const DONE = new Set(["added", "recorded", "updated", "sent", "qr_ready", "payment_received", "remembered", "forgotten"]);

/** Write actions that succeeded in these messages. */
export function completedActions(messages: ModelMessage[]): Action[] {
  const actions: Action[] = [];
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.output.type !== "json") continue;
      const output = part.output.value as Record<string, unknown> | null;
      if (output && typeof output.status === "string" && DONE.has(output.status)) actions.push({ tool: part.toolName, output });
    }
  }
  return actions;
}

const s = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/**
 * One line per saved change, built from the tool's output. Links, QRs and payment checks are
 * left out: the link, the QR image and the reply already show those.
 */
export function receiptLines(actions: Action[]): string[] {
  return actions.flatMap(({ tool, output }) => {
    switch (tool) {
      case "recordCredit":
        return [`🧾 Udhaar: ${s(output.customer)} ${s(output.amount)} · owes ${s(output.nowOwes)}`];
      case "recordPayment":
        return [`🧾 Payment: ${s(output.customer)} ${s(output.amount)} · owes ${s(output.nowOwes)}`];
      case "recordSale":
        return [`🧾 ${output.kind === "expense" ? "Expense" : "Sale"}: ${s(output.amount)}`];
      case "updateStock":
        return [`🧾 Stock: ${s(output.product)} now ${s(output.stock)}`];
      case "remember":
        return [`🧾 Remembered (${s(output.about)}): ${s(output.fact)}`];
      case "forget":
        return ["🧾 Forgotten"];
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

/** True when the reply says something was saved or sent, yet no write action succeeded. */
export function claimsUnbackedAction(reply: string, actions: Action[]): boolean {
  return actions.length === 0 && CLAIMS.some((pattern) => pattern.test(reply));
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
