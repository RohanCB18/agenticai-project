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
  /\b(recorded|saved|added|updated|noted down|logged|sent)\b/i, // English
  /\b(likh|record|add|darj|save|update|jod|note|bhej|entry)\s*(kar\s*)?(diya|diye|di|liya|liye|ho\s*gaya|ho\s*gaye|ho\s*gayi|hua|hui)\b/i, // Hinglish
  /\b(bardide|bareditini|bardidini|bardideeni|record\s*maadide|add\s*maadide|serisidini|serisidde|kalisidini|kalsidini)\b/i, // Kannada in English letters
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
