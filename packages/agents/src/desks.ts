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
  "updateCustomer",
  "customerHistory",
  "recordCredit",
  "recordPayment",
  "recordSale",
  "correctEntry",
  "getBalances",
  "getStock",
  "updateStock",
  "addProduct",
  "setReorderLevel",
  "setProductGst",
  "tagAllProducts",
  "sendPaymentLink",
  "showPaymentQr",
  "checkPayment",
  "paymentHabits",
  "askSupplierQuote",
  "placeSupplierOrder",
  "supplierDues",
  "paySupplier",
  "lookupGst",
  "checkGstPortal",
  "makeChart",
  ...MEMORY_TOOLS,
];

type Specialist = { purpose: string; tools: KhataToolName[]; rules: string[] };

const RULES = {
  credit: `"X ne 450 ka saaman liya", "X took 450 on credit", "X ge 450 udhaar" means recordCredit.`,
  payment: `"X ne 200 diye", "X paid 200" means recordPayment.`,
  correct: `When the owner says an entry was wrong ("galti ho gayi, 800 nahi 600 tha", "Ramesh ka 450 galat likha", "last wala hata do"), call correctEntry with the right amount, or 0 to remove it. Never record a new entry to fix a wrong one: live, that turned an ₹800 expense into ₹1,400.`,
  // "Say the link is ready for the owner to forward" came out live as "Owner ise forward kar sakte
  // hain", talking about the owner to the owner. So the rule now says to speak to them directly.
  link: "To collect dues over UPI, use sendPaymentLink. If it reports missing_phone, ask for the customer's number, save it with updateCustomer, then send the link. The owner will be asked to approve it. If they deny it, acknowledge and do not retry. If the tool returns a link, it is already approved, so never ask for approval again. If customerNotified is false, the customer has NOT been told: tell the owner, speaking to them directly, that the link is ready for them to forward (\"aap ise X ko bhej sakte hain\"), never that it was sent.",
  qr: `Any request for a QR ("QR dikhao", "X ka QR", "scan karega"), or a customer who is in the shop ("yahan khada hai"), means call showPaymentQr, without asking first or looking up the balance. Never offer a link when the owner asked for a QR. Only after it returns qr_ready, tell the owner the QR is on screen. If it reports qr_unavailable, offer a payment link.`,
  check: `"X ka payment aaya?" or "did X pay?" means checkPayment.`,
  habits: `For payment patterns ("X kab deti hai?"), use paymentHabits rather than memory or guesses.`,
  stock: `Stock that arrived ("10 packet Maggi aaya") is updateStock with a positive change; stock sold or used up is a negative change. "Kya khatam ho raha hai?" means getStock. "Rice 10 kg pe alert karna" (tell me when rice is down to 10 kg) means setReorderLevel. Owners name items in their own language (akki, chawal, sakkare): check getStock before deciding a word is a customer's name. Goods Munshi doesn't know yet are added with addProduct (ask the unit if the owner didn't say it).`,
  restock: `To restock, askSupplierQuote gets a quote from the wholesaler's agent (omit items to quote everything running low). Tell the owner the items, the total and the delivery slot, and what the wholesaler can't supply. Only after the owner says yes, call placeSupplierOrder; the owner then approves it with a button. Never state a price the quote didn't give.`,
  payout: `To pay a supplier or wholesaler ("Sharma Traders ko payment karo"), call supplierDues, with the amount if the owner named one, and tell the owner where it would go, then ask one yes-or-no question about one amount: the amount the owner named, or the whole due if they named none ("UPI su•••@upi pe jayega. Sharma Traders ko ₹100 bhejun?"), and end with that question. Never swap the owner's amount for the whole due. Never ask "this or that?": live, "haan" to "₹100 ya poora ₹3,900?" meant nothing. It is a payment to the supplier, never an expense. Only after the owner says yes, call paySupplier with that amount; the owner then approves it with a button, and gets a Cashfree payment page to pay (Cashfree sends the money on to the supplier). If there is no verified account, tell the owner to add it in Munshi's dashboard: Munshi can never add or change where money goes. Never say money reached the supplier unless paySupplier returned paid.`,
  portal: `checkGstPortal looks an item up on the official GST portal in the background, in about a minute. Use it only when lookupGst found no clear entry for the item, or the owner asks for the portal. For an HSN code, call lookupGst first: its entries carry HSN codes. Never use the portal to tag a product ("HSN laga do"): that is lookupGst, then setProductGst. Never tell the owner an HSN code no official entry showed.`,
  chart: `For a chart or graph ("is mahine ki sale chart mein dikhao", "udhaar ka graph"), call makeChart with what it is about, the period (is mahine = this_month, pichhle mahine = last_month, is hafte = last_7_days) and a short Python program that reads daily.csv, ledger.csv or stock.csv. In a kirana, goods given on udhaar are sales too: unless the owner says cash only, a sales chart is about "sales" and draws cash sales and udhaar. If it returns chart_error, fix the program and call it again once. If it returns nothing_to_chart, no picture was drawn: say so in one sentence. Otherwise the picture goes to the owner by itself: reply with one sentence, amounts from its totals and anything else from its summary.`,
  history: `For what a customer took or paid over a period ("Ramesh ne pichhle mahine kya liya?", "Fatima ne is hafte kitna diya?"), use customerHistory with the number of days (a week is 7, a month is 30). Answer from its entries and notes; never guess what they bought.`,
  customer: `To add or change an existing customer's mobile number ("Fatima ka number 98...") or fix their name, use updateCustomer. addCustomer is only for someone new.`,
  gst: `For GST questions ("Maggi pe kitna GST?", "atta pe GST lagta hai?"), call lookupGst with a generic English item name (Maggi is instant noodles, atta is wheat flour) and answer only from what it returns: the total GST, then the notification and S. No. it comes from. Loose and packed goods often differ; if the owner didn't say which, give both. If nothing fits, say you aren't sure and suggest their CA. Never state a GST rate from memory.`,
  gstTag: `To tag a product for GST bills ("Maggi ka HSN laga do"), find its HSN code with lookupGst (or take it from the supplier's bill), then call setProductGst with that code. To tag every untagged product at once ("baaki sab ka HSN laga do", "saare products tag karo"), call tagAllProducts with no products, then again with each one's usual HSN code and a generic English description of the goods: it tags only codes the official entries confirm, and lists the loose-or-packed choices to ask the owner about. Never pass a gstRate the owner didn't choose from the options listed. getStock shows each product's tag, or "not tagged".`,
  memory: `When the owner tells you a lasting fact or a preference ("Ramesh is Lakshmi's husband", "call me Akka", "Fatima pays on Saturdays"), save it with remember. Before answering about a customer's background, check recall and repeat what it says without adding to it: "the owner" in a fact means the person you are talking to, so say "your", and any other name is someone else.`,
};

export const SPECIALISTS: Record<Exclude<Desk, "general">, Specialist> = {
  khata: {
    purpose: "the khata: udhaar given, cash payments received, sales, expenses, balances, a customer's history and customer details",
    tools: ["findCustomer", "addCustomer", "updateCustomer", "customerHistory", "recordCredit", "recordPayment", "recordSale", "correctEntry", "getBalances", "makeChart", ...MEMORY_TOOLS],
    rules: [RULES.credit, RULES.payment, RULES.correct, RULES.history, RULES.customer, RULES.chart, RULES.memory],
  },
  collections: {
    purpose: "collecting dues: payment links, QR codes, checking whether a customer paid, cash handed over, and how customers usually pay",
    // Cash payments and sales live at the khata desk too. The router mixes up "money came in" and
    // "collect money" (in testing it sent "Fatima 100 rupayi kottru" here), so both desks can record it.
    tools: [
      "findCustomer",
      "getBalances",
      "recordPayment",
      "recordSale",
      "correctEntry",
      "sendPaymentLink",
      "showPaymentQr",
      "checkPayment",
      "paymentHabits",
      "customerHistory",
      "updateCustomer",
      ...MEMORY_TOOLS,
    ],
    rules: [RULES.payment, RULES.link, RULES.qr, RULES.check, RULES.habits, RULES.history, RULES.customer, RULES.memory],
  },
  stock: {
    purpose: "stock: what is left, what arrived, what sold, what is running low, reordering from and paying the wholesaler, the GST on goods and tagging products with their HSN code and GST rate",
    // GST questions name a product ("Maggi pe kitna GST?"), so the router often sends them here.
    tools: ["getStock", "updateStock", "addProduct", "setReorderLevel", "setProductGst", "tagAllProducts", "recordSale", "askSupplierQuote", "placeSupplierOrder", "supplierDues", "paySupplier", "lookupGst", "checkGstPortal", "makeChart", ...MEMORY_TOOLS],
    rules: [RULES.stock, RULES.restock, RULES.payout, RULES.gst, RULES.gstTag, RULES.portal, RULES.chart, RULES.memory],
  },
};

const GENERAL_RULES = [
  RULES.credit,
  RULES.payment,
  RULES.correct,
  RULES.link,
  RULES.qr,
  RULES.check,
  RULES.habits,
  RULES.history,
  RULES.customer,
  RULES.stock,
  RULES.restock,
  RULES.payout,
  RULES.gst,
  RULES.gstTag,
  RULES.portal,
  RULES.chart,
  RULES.memory,
];

const CORE_RULES = [
  "Use tools for every fact about money or stock. Never guess balances or invent customers.",
  "Never say something is done, recorded, sent or ready unless a tool confirmed it in this conversation.",
  "If a tool reports customer_not_found, ambiguous_customer, product_not_found, ambiguous_product or possible_repeat, ask the owner a short question instead of guessing.",
  "Record every entry the owner reports, even if the chat has a similar message before: the tools check the ledger for repeats and tell you when to ask. Never skip an entry because of earlier messages.",
  "If the owner reports money or goods changing hands and you don't record it, say so plainly and ask. Never answer only the rest of the message.",
  // Live: "Owner ise forward kar sakte hain", said to the owner.
  "You are talking to the shop owner: speak to them directly (aap, you). Never call them \"the owner\" or \"Owner\" in a reply.",
  // Live: "order de diya gaya hai... ab button se approve kar dijiye", before the button was tapped.
  "A payment link, a wholesaler order or a supplier payment waits for the owner's button. Until that tool returns its result, say only what will happen when they tap it, never that it is done, placed, sent or paid.",
];

const messagingNote = (app: string) => `

You are chatting with the owner on ${app}:
- Plain text only: no markdown, tables, headings or links in brackets.
- When a payment link is created, include the link in your reply.`;

const CHANNEL_NOTES: Record<Channel, string> = { app: "", telegram: messagingNote("Telegram"), whatsapp: messagingNote("WhatsApp") };

function talkRules(language: Language) {
  return `How to talk:
- Reply in the language and script of the owner's LATEST message, even if earlier messages were in another language. Owners switch languages mid-chat; follow them every time. If unclear, use ${LANGUAGE_NAMES[language]}.
- Owners often write Indian languages in English letters. Reply the same way, never in Hinglish unless they wrote Hinglish:
  - Kannada (avru, togondru, kottru, eshtu, ide, baaki ide): "Ramesh avru 450 saaman togondru" gets "Ramesh ge 450 udhaar bardide. Eega 450 baaki ide."
  - Tamil (avaru, vaangunaar, evvalavu, irukku): "Ramesh evvalavu baaki irukku?" gets "Ramesh ku 450 baaki irukku."
  - Hinglish (ne, liya, diye, kitna, hai): "Ramesh ne 450 ka saaman liya" gets "Ramesh ka 450 udhaar likh diya."
- Owners who write in their language's own script get the reply in that script, names included, never in English letters: "ರಮೇಶ್ 450 ರೂಪಾಯಿ ಸಾಮಾನು ತಗೊಂಡ" gets "ರಮೇಶ್ ಅವರಿಗೆ 450 ರೂಪಾಯಿ ಉದ್ರಿ ಬರೆದಿದೆ. ಈಗ 450 ಬಾಕಿ ಇದೆ."
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

export type Route = { desk: Desk; by: "model" | "qr" | "approval" | "answer" | "fallback"; ms: number; tokens: number };

/**
 * The desk that holds the tool Munshi used just before its question, so a short answer ("haan")
 * goes back to the desk that asked. Live, "poora 3,900 payment karun?" (asked by the stock desk
 * after supplierDues) was answered "haan" four times, and the router sent each one to the
 * collections desk, which can't pay a supplier: four empty replies.
 */
export function deskThatAsked(messages: ModelMessage[]): Desk | null {
  const before = messages.slice(0, -1);
  let lastOwner = -1;
  before.forEach((message, i) => {
    if (message.role === "user") lastOwner = i;
  });
  const turn = before.slice(lastOwner + 1);
  const tools = turn.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolName] : [])) : []));
  const tool = tools.filter((name) => name !== "handOff").at(-1);
  if (!tool) return null;
  return (Object.keys(SPECIALISTS) as Exclude<Desk, "general">[]).find((desk) => (SPECIALISTS[desk].tools as string[]).includes(tool)) ?? null;
}

const ROUTER_PROMPT = `You route a shop owner's message to one desk of their bookkeeping assistant. The message may be in any Indian language, in its own script or in English letters. Reply with one word only: khata, collections, stock or general.

khata: udhaar given, money a customer handed over in cash, sales, expenses, who owes how much, what a customer took or paid over time, charts of sales or udhaar, adding a customer or their phone number, fixing or removing a wrong entry.
  "Suresh ne 300 ka samaan liya", "Galti ho gayi, bijli ka bill 800 nahi 600 tha", "सुरेश ने 500 रुपये दिए", "Lakshmi 200 kottlu", "Kal 900 ka dhanda hua", "Dukaan ka kiraya 5000 diya", "Lakshmi ku evvalavu baaki?", "Suresh ne is mahine kya kya liya?", "Is mahine ki sale ka chart dikhao", "Lakshmi ka number 9876543210 hai"
collections: getting paid over UPI: sending a payment link, showing a QR code, checking whether an online payment arrived, when a customer usually pays.
  "Suresh ko link bhej do", "Lakshmi ka QR banao", "Suresh ne online bheja kya?", "Lakshmi aam taur par kab paisa deti hai?"
stock: how much of an item is left, stock that arrived or sold, what is running low, ordering more from the wholesaler, paying the wholesaler, GST on goods, HSN codes, tagging a product with its HSN code and GST rate.
  "Atta kitna hai?", "Sakkare eshtu ide?", "20 packet biscuit aaye", "Tel 2 litre bika", "Wholesaler se dal ka rate pucho", "Sharma Traders ko payment kar do", "Maggi pe kitna GST lagta hai?", "Rice ka HSN laga do", "Baaki sab products ka HSN laga do", "Maggi naya product hai, 20 packet aaye", "Makhana ka HSN code kya hai?"
general: greetings, thanks, remembering or recalling facts, anything else, or a message that needs more than one desk.
  "Hello ji", "Yaad rakhna, Suresh Monday ko aata hai", "Lakshmi kaun hai?"

If the owner only answers a question Munshi asked ("haan", "no", "bhej do"), route by what Munshi asked. Otherwise route by the owner's message alone. When the shop's records say a word is a product, the message is about that product.`;

/**
 * Whether Munshi's reply ends by asking something, allowing a short note after the question. Live,
 * "Unko ₹100 bhejun? UPI su•••@upi pe jayega." didn't count, and "Haan, pay karo." went to the
 * collections desk, which recorded it as a customer's payment.
 */
export function endsWithQuestion(text: string) {
  const at = text.lastIndexOf("?");
  return at >= 0 && text.slice(at + 1).trim().length <= 60;
}

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
  const answering = previous && endsWithQuestion(textOf(previous)) && ownerText.split(/\s+/).filter(Boolean).length <= 4;
  if (answering) {
    const desk = deskThatAsked(messages);
    if (desk) return { desk, by: "answer", ms: 0, tokens: 0 };
  }
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
      telemetry: { functionId: "desk-router" },
    });
    const desk = result.text.toLowerCase().match(/khata|collections|stock|general/)?.[0] as Desk | undefined;
    const tokens = (result.totalUsage.inputTokens ?? 0) + (result.totalUsage.outputTokens ?? 0);
    return desk ? { desk, by: "model", ms: Date.now() - started, tokens } : { desk: "general", by: "fallback", ms: Date.now() - started, tokens };
  } catch {
    return { desk: "general", by: "fallback", ms: Date.now() - started, tokens: 0 };
  }
}
