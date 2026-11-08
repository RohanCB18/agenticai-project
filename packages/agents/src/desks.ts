import type { Language } from "@munshi/db";
import { generateText, type LanguageModel, type ModelMessage, tool } from "ai";
import { z } from "zod";
import type { createKhataTools } from "./tools";

// Munshi's specialists. Each owner message goes to one desk, which sees only its own rules and
// tools: a smaller prompt for the model to follow and fewer tools to pick wrongly from. "general"
// has everything and takes greetings, mixed requests and anything the router isn't sure about.

export const DESKS = ["khata", "collections", "stock", "general"] as const;
export type Desk = (typeof DESKS)[number];
export type Channel = "app" | "telegram" | "whatsapp";

type KhataToolName = keyof ReturnType<typeof createKhataTools>;
export type ToolName = KhataToolName | "handOff";

const LANGUAGE_NAMES: Record<Language, string> = { kn: "Kannada", hi: "Hindi", ta: "Tamil", bn: "Bengali", en: "English" };

const MEMORY_TOOLS = ["remember", "recall", "forget"] as const;

const ALL_TOOLS: KhataToolName[] = [
  "findCustomer",
  "addCustomer",
  "recordCredit",
  "recordPayment",
  "recordSale",
  "getBalances",
  "getStock",
  "updateStock",
  "sendPaymentLink",
  "showPaymentQr",
  "checkPayment",
  "paymentHabits",
  ...MEMORY_TOOLS,
];

type Specialist = { purpose: string; tools: KhataToolName[]; rules: string[] };

const RULES = {
  credit: `"X ne 450 ka saaman liya", "X took 450 on credit", "X ge 450 udhaar" means recordCredit.`,
  payment: `"X ne 200 diye", "X paid 200" means recordPayment.`,
  link: "To collect dues over UPI, use sendPaymentLink. The owner will be asked to approve it. If they deny it, acknowledge and do not retry. If the tool returns a link, it is already approved, so never ask for approval again. If customerNotified is false, the customer has NOT been told: say the link is ready for the owner to forward, never that it was sent.",
  qr: `Any request for a QR ("QR dikhao", "X ka QR", "scan karega"), or a customer who is in the shop ("yahan khada hai"), means call showPaymentQr, without asking first or looking up the balance. Never offer a link when the owner asked for a QR. Only after it returns qr_ready, tell the owner the QR is on screen. If it reports qr_unavailable, offer a payment link.`,
  check: `"X ka payment aaya?" or "did X pay?" means checkPayment.`,
  habits: `For payment patterns ("X kab deti hai?"), use paymentHabits rather than memory or guesses.`,
  stock: `Stock that arrived ("10 packet Maggi aaya") is updateStock with a positive change; stock sold or used up is a negative change. "Kya khatam ho raha hai?" means getStock. Owners name items in their own language (akki, chawal, sakkare): check getStock before deciding a word is a customer's name.`,
  memory: `When the owner tells you a lasting fact or a preference ("Ramesh is Lakshmi's husband", "call me Akka", "Fatima pays on Saturdays"), save it with remember. Before answering about a customer's background, check recall and repeat what it says without adding to it: "the owner" in a fact means the person you are talking to, so say "your", and any other name is someone else.`,
};

export const SPECIALISTS: Record<Exclude<Desk, "general">, Specialist> = {
  khata: {
    purpose: "the khata: udhaar given, cash payments received, sales, expenses, balances and customers",
    tools: ["findCustomer", "addCustomer", "recordCredit", "recordPayment", "recordSale", "getBalances", ...MEMORY_TOOLS],
    rules: [RULES.credit, RULES.payment, RULES.memory],
  },
  collections: {
    purpose: "collecting dues: payment links, QR codes, checking whether a customer paid, cash handed over, and how customers usually pay",
    // Cash payments and sales live at the khata desk too. The router mixes up "money came in" and
    // "collect money" (in testing it sent "Fatima 100 rupayi kottru" here), so both desks can record it.
    tools: ["findCustomer", "getBalances", "recordPayment", "recordSale", "sendPaymentLink", "showPaymentQr", "checkPayment", "paymentHabits", ...MEMORY_TOOLS],
    rules: [RULES.payment, RULES.link, RULES.qr, RULES.check, RULES.habits, RULES.memory],
  },
  stock: {
    purpose: "stock: what is left, what arrived, what sold and what is running low",
    tools: ["getStock", "updateStock", "recordSale", ...MEMORY_TOOLS],
    rules: [RULES.stock, RULES.memory],
  },
};

const GENERAL_RULES = [RULES.credit, RULES.payment, RULES.link, RULES.qr, RULES.check, RULES.habits, RULES.stock, RULES.memory];

const CORE_RULES = [
  "Use tools for every fact about money or stock. Never guess balances or invent customers.",
  "Never say something is done, recorded, sent or ready unless a tool confirmed it in this conversation.",
  "If a tool reports customer_not_found, ambiguous_customer, product_not_found, ambiguous_product or possible_repeat, ask the owner a short question instead of guessing.",
  "Record every entry the owner reports, even if the chat has a similar message before: the tools check the ledger for repeats and tell you when to ask. Never skip an entry because of earlier messages.",
  "If the owner reports money or goods changing hands and you don't record it, say so plainly and ask. Never answer only the rest of the message.",
];

const messagingNote = (app: string) => `

You are chatting with the owner on ${app}:
- Plain text only: no markdown, tables, headings or links in brackets.
- When a payment link is created, include the link in your reply so the owner can forward it to the customer.`;

const CHANNEL_NOTES: Record<Channel, string> = { app: "", telegram: messagingNote("Telegram"), whatsapp: messagingNote("WhatsApp") };

function talkRules(language: Language) {
  return `How to talk:
- Reply in the language and script of the owner's LATEST message, even if earlier messages were in another language. Owners switch languages mid-chat; follow them every time. If unclear, use ${LANGUAGE_NAMES[language]}.
- Owners often write Indian languages in English letters. Reply the same way, never in Hinglish unless they wrote Hinglish:
  - Kannada (avru, togondru, kottru, eshtu, ide, baaki ide): "Ramesh avru 450 saaman togondru" gets "Ramesh ge 450 udhaar bardide. Eega 450 baaki ide."
  - Tamil (avaru, vaangunaar, evvalavu, irukku): "Ramesh evvalavu baaki irukku?" gets "Ramesh ku 450 baaki irukku."
  - Hinglish (ne, liya, diye, kitna, hai): "Ramesh ne 450 ka saaman liya" gets "Ramesh ka 450 udhaar likh diya."
- Be brief: one or two short sentences, like a trusted shop assistant. Always say amounts in rupees.
- Never mention tools, desks, JSON or internal ids.`;
}

/** The instructions for one desk. "general" is the whole job, as one agent would do it. */
export function deskInstructions(desk: Desk, shopName: string, language: Language, channel: Channel = "app"): string {
  const intro = `You are Munshi, the bookkeeper (munshi) of "${shopName}", a small Indian shop. You keep the khata: udhaar (store credit), payments, sales, expenses and stock.`;
  const specialist = desk === "general" ? null : SPECIALISTS[desk];
  const focus = specialist
    ? `\n\nFor this message you are at the ${desk} desk, which handles ${specialist.purpose}. If the owner asks for something this desk's tools can't do, call handOff with the desk that can (${DESKS.filter((d) => d !== desk).join(", ")}); its tools are yours right after.`
    : "";
  const rules = [...CORE_RULES, ...(specialist?.rules ?? GENERAL_RULES)];
  return `${intro}${focus}

${talkRules(language)}

How to work:
${rules.map((rule) => `- ${rule}`).join("\n")}${CHANNEL_NOTES[channel]}`;
}

/** The whole job for one agent; kept for callers that don't route. */
export function khataInstructions(shopName: string, language: Language, channel: Channel = "app"): string {
  return deskInstructions("general", shopName, language, channel);
}

/** The tools a desk may use. After a hand-off, no second hand-off: the turn stays at that desk. */
export function deskTools(desk: Desk, canHandOff: boolean): ToolName[] {
  if (desk === "general") return ALL_TOOLS;
  return canHandOff ? [...SPECIALISTS[desk].tools, "handOff"] : SPECIALISTS[desk].tools;
}

export const handOffTool = tool({
  description: "Pass this message to another desk when the owner asks for something your tools can't do. That desk's tools are available right after.",
  inputSchema: z.object({ desk: z.enum(DESKS) }),
  // In testing, a desk that was handed a message sometimes replied "passed to the khata desk"
  // and stopped. The result says otherwise, and the next step must call a tool (see justHandedOff).
  execute: async ({ desk }) => ({
    status: "handed_off",
    desk,
    next: `You are now the ${desk} desk. Do what the owner asked with your tools now. Never mention desks to the owner.`,
  }),
});

/** True right after a hand-off: the newest message is the hand-off's result. */
export function justHandedOff(messages: ModelMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "tool" && last.content.some((part) => part.type === "tool-result" && part.toolName === "handOff");
}

/** The desk a hand-off in this turn moved the conversation to, if any. */
export function handedOffTo(messages: ModelMessage[]): Desk | null {
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== "user"; i--) {
    const message = messages[i]!;
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolName === "handOff" && part.output.type === "json") {
        const desk = (part.output.value as { desk?: unknown } | null)?.desk;
        if (typeof desk === "string" && (DESKS as readonly string[]).includes(desk)) return desk as Desk;
      }
    }
  }
  return null;
}

export type Route = { desk: Desk; by: "model" | "qr" | "approval" | "fallback"; ms: number; tokens: number };

const ROUTER_PROMPT = `You route a shop owner's message to one desk of their bookkeeping assistant. The message may be in any Indian language, in its own script or in English letters. Reply with one word only: khata, collections, stock or general.

khata: udhaar given, money a customer handed over in cash, sales, expenses, who owes how much, adding a customer.
  "Suresh ne 300 ka samaan liya", "सुरेश ने 500 रुपये दिए", "Lakshmi 200 kottlu", "Kal 900 ka dhanda hua", "Dukaan ka kiraya 5000 diya", "Lakshmi ku evvalavu baaki?"
collections: getting paid over UPI: sending a payment link, showing a QR code, checking whether an online payment arrived, when a customer usually pays.
  "Suresh ko link bhej do", "Lakshmi ka QR banao", "Suresh ne online bheja kya?", "Lakshmi aam taur par kab paisa deti hai?"
stock: how much of an item is left, stock that arrived or sold, what is running low.
  "Atta kitna hai?", "Sakkare eshtu ide?", "20 packet biscuit aaye", "Tel 2 litre bika"
general: greetings, thanks, remembering or recalling facts, anything else, or a message that needs more than one desk.
  "Hello ji", "Yaad rakhna, Suresh Monday ko aata hai", "Lakshmi kaun hai?"

If the owner only answers a question Munshi asked ("haan", "no", "bhej do"), route by what Munshi asked. Otherwise route by the owner's message alone. When the shop's records say a word is a product, the message is about that product.`;

const textOf = (message: ModelMessage | undefined) => {
  if (!message || message.role === "tool") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ").trim();
};

/**
 * Picks the desk for the owner's latest message. One short model call with reasoning off (about
 * 0.2 s on Sarvam). Approvals and QR requests skip the call; any failure falls back to "general",
 * which can do everything, so a router problem costs focus, never a wrong answer.
 */
export async function routeMessage(model: LanguageModel, messages: ModelMessage[], asksForQr: boolean, shopRecords?: string | null): Promise<Route> {
  const started = Date.now();
  const last = messages.at(-1);
  if (last?.role === "tool") return { desk: "general", by: "approval", ms: 0, tokens: 0 };
  if (asksForQr) return { desk: "collections", by: "qr", ms: 0, tokens: 0 };

  const ownerText = textOf(last);
  // Munshi's last words matter only when it asked something and the owner is answering ("haan",
  // "bhej do"). Otherwise they mislead: live, after "Ramesh ka balance 0 rupaye hai.", the
  // three-word "Akki eshtu ide" went to the khata desk.
  const previous = [...messages.slice(0, -1)].reverse().find((message) => message.role === "assistant" && textOf(message));
  const answering = previous && textOf(previous).trim().endsWith("?") && ownerText.split(/\s+/).filter(Boolean).length <= 4;
  const prompt = [
    answering ? `Munshi asked: ${textOf(previous).slice(0, 300)}` : null,
    `Owner: ${ownerText.slice(0, 500)}`,
    shopRecords ? `In this shop's records, ${shopRecords}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const result = await generateText({
      model,
      system: ROUTER_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: 20,
      maxRetries: 0, // "general" right away beats retrying a router call while the owner waits
      providerOptions: { sarvam: { reasoningEffort: "none" } },
      abortSignal: AbortSignal.timeout(5000),
    });
    const desk = result.text.toLowerCase().match(/khata|collections|stock|general/)?.[0] as Desk | undefined;
    const tokens = (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0);
    return desk ? { desk, by: "model", ms: Date.now() - started, tokens } : { desk: "general", by: "fallback", ms: Date.now() - started, tokens };
  } catch {
    return { desk: "general", by: "fallback", ms: Date.now() - started, tokens: 0 };
  }
}
