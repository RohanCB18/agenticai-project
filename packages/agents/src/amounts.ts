import type { ModelMessage } from "ai";

// The amount the owner named, read by code from their own words. Live, "Sharma Traders ko 100
// rupaye payment kar do" twice got "poora 3,900 payment karun?": the model was asked to pass the
// owner's amount to supplierDues and didn't, so the tool reads it from the message itself.

const CURRENCY = String.raw`(?:₹|rs\.?|inr|rupees?|rupaye|rupaiye|rupay|rupiya|रुपये|रुपए|रुपया|ರೂಪಾಯಿ)`;
const NUMBER = String.raw`(\d[\d,]*(?:\.\d{1,2})?)`;
// A currency word on either side of a number, not inside another word ("Traders 100" isn't "rs 100").
const NEXT_TO_CURRENCY = [
  new RegExp(String.raw`(?<![\p{L}\p{N}])${CURRENCY}\s*${NUMBER}`, "iu"),
  new RegExp(String.raw`${NUMBER}\s*${CURRENCY}(?![\p{L}])`, "iu"),
];
// A number standing alone, not part of a name or code like "ST-2" or "2026-11".
const LONE_NUMBER = /(?<![\p{L}\p{N}_.,/-])(\d[\d,]*(?:\.\d{1,2})?)(?![\p{L}\p{N}_,/-])/gu;

const toRupees = (digits: string) => {
  const value = Number(digits.replaceAll(",", ""));
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** The rupee amount in a message: one next to a currency word, else the only number in it. */
export function amountInWords(text: string): number | null {
  for (const pattern of NEXT_TO_CURRENCY) {
    const match = pattern.exec(text);
    if (match?.[1]) return toRupees(match[1]);
  }
  const lone = [...text.matchAll(LONE_NUMBER)].map((m) => m[1]!);
  return lone.length === 1 ? toRupees(lone[0]!) : null;
}

/** What the owner said last, as text. */
export function lastOwnerText(messages: ModelMessage[]): string {
  let last: ModelMessage | undefined;
  for (const message of messages) if (message.role === "user") last = message;
  if (!last || last.role !== "user") return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}
