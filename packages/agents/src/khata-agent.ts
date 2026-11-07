import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Language } from "@munshi/db";
import { isStepCount, type ModelMessage, ToolLoopAgent, type InferAgentUIMessage, wrapLanguageModel } from "ai";
import type { KhataStore } from "./store";
import { createKhataTools } from "./tools";
import type { DetectedLanguage } from "./voice";

const LANGUAGE_NAMES: Record<Language, string> = { kn: "Kannada", hi: "Hindi", ta: "Tamil", bn: "Bengali", en: "English" };

export type Channel = "app" | "telegram" | "whatsapp";

const messagingNote = (app: string) => `

You are chatting with the owner on ${app}:
- Plain text only: no markdown, tables, headings or links in brackets.
- When a payment link is created, include the link in your reply so the owner can forward it to the customer.`;

const CHANNEL_NOTES: Record<Channel, string> = { app: "", telegram: messagingNote("Telegram"), whatsapp: messagingNote("WhatsApp") };

export function khataInstructions(shopName: string, language: Language, channel: Channel = "app"): string {
  return `You are Munshi, the bookkeeper (munshi) of "${shopName}", a small Indian shop. You keep the khata: udhaar (store credit), payments, sales, expenses and stock.

How to talk:
- Reply in the language and script of the owner's LATEST message, even if earlier messages were in another language. Owners switch languages mid-chat; follow them every time. If unclear, use ${LANGUAGE_NAMES[language]}.
- Owners often write Indian languages in English letters. Reply the same way, never in Hinglish unless they wrote Hinglish:
  - Kannada (avru, togondru, kottru, eshtu, ide, baaki ide): "Ramesh avru 450 saaman togondru" gets "Ramesh ge 450 udhaar bardide. Eega 450 baaki ide."
  - Tamil (avaru, vaangunaar, evvalavu, irukku): "Ramesh evvalavu baaki irukku?" gets "Ramesh ku 450 baaki irukku."
  - Hinglish (ne, liya, diye, kitna, hai): "Ramesh ne 450 ka saaman liya" gets "Ramesh ka 450 udhaar likh diya."
- Be brief: one or two short sentences, like a trusted shop assistant. Always say amounts in rupees.
- Never mention tools, JSON or internal ids.

How to work:
- Use tools for every fact about money or stock. Never guess balances or invent customers.
- Never say something is done, recorded, sent or ready unless a tool confirmed it in this conversation.
- "X ne 450 ka saaman liya", "X took 450 on credit", "X ge 450 udhaar" means recordCredit.
- "X ne 200 diye", "X paid 200" means recordPayment.
- If a tool reports customer_not_found or ambiguous_customer, ask the owner a short question instead of guessing.
- To collect dues over UPI, use sendPaymentLink. The owner will be asked to approve it. If they deny it, acknowledge and do not retry. If the tool returns a link, it is already approved, so never ask for approval again. If customerNotified is false, the customer has NOT been told: say the link is ready for the owner to forward, never that it was sent.
- Any request for a QR ("QR dikhao", "X ka QR", "scan karega"), or a customer who is in the shop ("yahan khada hai"), means call showPaymentQr, without asking first or looking up the balance. Never offer a link when the owner asked for a QR. Only after it returns qr_ready, tell the owner the QR is on screen. If it reports qr_unavailable, offer a payment link.
- "X ka payment aaya?" or "did X pay?" means checkPayment.
- Never record the same entry twice. If the owner repeats themselves, ask whether it is a new entry.${CHANNEL_NOTES[channel]}`;
}

const REPLY_LANGUAGES: Record<string, string> = {
  "hi-IN": "Hindi",
  "kn-IN": "Kannada",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "bn-IN": "Bengali",
  "ml-IN": "Malayalam",
  "mr-IN": "Marathi",
  "gu-IN": "Gujarati",
  "pa-IN": "Punjabi",
};

/** The instruction that pins a reply to the owner's latest language. Null when it can't be named. */
export function replyLanguageRule(detected: DetectedLanguage): string | null {
  const latin = detected.scriptCode === "Latn";
  if (detected.languageCode === "en-IN") return "The owner's latest message is in English. Reply only in English, with no Hindi words, even if earlier messages were in Hindi.";
  const name = REPLY_LANGUAGES[detected.languageCode];
  if (!name) return null;
  return latin
    ? `The owner's latest message is ${name} written in English letters. Reply in ${name}, written in English letters.`
    : `The owner's latest message is in ${name}. Reply in ${name}, in its own script.`;
}

/** Adds a note as the last thing the model reads, for this call only: it never joins the thread. */
function withClosingNote(model: LanguageModelV4, note: string) {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({ ...params, prompt: [...params.prompt, { role: "system", content: note }] }),
    },
  });
}

/** The newest thing the owner wrote, ignoring tool messages that follow it. */
function latestOwnerText(messages: ModelMessage[]) {
  const last = messages.filter((message) => message.role === "user").at(-1);
  if (!last) return "";
  return typeof last.content === "string" ? last.content : last.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

// "QR" as speech-to-text writes it in each language.
const QR_WORDS = /\bqr\b|क्यूआर|ಕ್ಯೂಆರ್|க்யூஆர்|কিউআর/i;

/** True when the newest message is the owner asking for a QR. */
export function asksForQr(messages: ModelMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "user") return false;
  const text = typeof last.content === "string" ? last.content : last.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
  return QR_WORDS.test(text);
}

export type KhataAgentOptions = {
  model: LanguageModelV4;
  store: KhataStore;
  shopName: string;
  language: Language;
  approvalSecret?: string;
  channel?: Channel;
  /** Names the language of the owner's latest message. Without it, the instructions alone decide. */
  detectLanguage?: (text: string) => Promise<DetectedLanguage | null>;
};

export function createKhataAgent({ model, store, shopName, language, approvalSecret, channel, detectLanguage }: KhataAgentOptions) {
  // One detection per turn; every step of the loop reuses it. A failed detection isn't fatal.
  let languageRule: Promise<string | null> | undefined;
  const replyRule = (messages: ModelMessage[]) => {
    languageRule ??= (async () => {
      const text = latestOwnerText(messages);
      const detected = text && detectLanguage ? await detectLanguage(text).catch(() => null) : null;
      return detected ? replyLanguageRule(detected) : null;
    })();
    return languageRule;
  };

  return new ToolLoopAgent({
    model,
    instructions: khataInstructions(shopName, language, channel),
    tools: createKhataTools(store, shopName),
    // Money only moves after the owner says yes; approvals are HMAC-signed so a
    // client cannot forge one.
    toolApproval: { sendPaymentLink: "user-approval" },
    experimental_toolApprovalSecret: approvalSecret,
    stopWhen: isStepCount(8),
    // Force the tool for QR requests: in live testing the model said "QR ready" without calling
    // it. An owner showing a customer a QR that doesn't exist is not something to leave to a prompt.
    // (Sarvam rejects naming a tool in tool_choice, so offer only this tool and require a call.)
    prepareStep: async ({ stepNumber, messages }) => {
      // The model follows the language of the recent chat over any rule at the top of the
      // prompt, so the language of this message is the last thing it reads on every step.
      const rule = await replyRule(messages);
      return {
        ...(rule ? { model: withClosingNote(model, rule) } : {}),
        ...(stepNumber === 0 && asksForQr(messages) ? { activeTools: ["showPaymentQr" as const], toolChoice: "required" as const } : {}),
      };
    },
  });
}

export type KhataAgent = ReturnType<typeof createKhataAgent>;
export type KhataUIMessage = InferAgentUIMessage<KhataAgent>;
