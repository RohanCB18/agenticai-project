import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Language } from "@munshi/db";
import { isStepCount, type ModelMessage, ToolLoopAgent, type InferAgentUIMessage, wrapLanguageModel } from "ai";
import { type Channel, type Desk, deskInstructions, deskTools, handedOffTo, handOffTool, justHandedOff, type Route, routeMessage } from "./desks";
import type { KnowledgeBase } from "./knowledge";
import type { KhataStore } from "./store";
import type { SupplierAgent } from "./supplier";
import { findMentions, type Mention, mentionsHint, mentionsNote } from "./mentions";
import { completedActions, reportsEntry } from "./receipts";
import { forgetOldToolResults } from "./threads";
import { createKhataTools } from "./tools";
import type { DetectedLanguage } from "./voice";

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

/** Read on every step: earlier replies in the chat quote figures that may have changed since. */
export const FRESH_FIGURES_RULE =
  "Balances, payments and stock may have changed since earlier messages (bills, payments, other devices). Never repeat a figure from earlier in the chat: call the tool again in this turn before stating any balance or stock.";

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

/**
 * Read while an owner's report of money or goods changing hands has no entry yet. Live, the
 * owner resent "Ramesh ne 200 diye" and the model copied its earlier balance-only answer.
 */
export const RECORD_IT_NOTE =
  "The owner's latest message reports money or goods changing hands. Record it with the right tool before answering anything else; the tool says if it looks like a repeat. Only if it is clearly a question about an old entry, ask instead.";

/** True once this turn saved an entry, or a tool asked whether it was a repeat. */
function entrySettledThisTurn(messages: ModelMessage[]) {
  let lastOwner = messages.length - 1;
  while (lastOwner >= 0 && messages[lastOwner]!.role !== "user") lastOwner--;
  const turn = messages.slice(lastOwner + 1);
  const asked = turn.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((part) => part.type === "tool-result" && part.output.type === "json" && (part.output.value as { status?: unknown } | null)?.status === "possible_repeat"),
  );
  return asked || completedActions(turn).length > 0;
}

/** True once a tool has answered since the owner's latest message. */
function hasResultThisTurn(messages: ModelMessage[]) {
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== "user"; i--) {
    const message = messages[i]!;
    if (message.role === "tool" && message.content.some((part) => part.type === "tool-result")) return true;
  }
  return false;
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
  /** One more closing note for this run, e.g. after a reply claimed an action no tool took. */
  extraNote?: string;
  /** Route each message to a specialist desk (default). False runs one agent with every tool. */
  specialists?: boolean;
  /** Told which desk took the message, for logs and evals. */
  onRoute?: (route: Route) => void;
  /** The wholesaler to restock from (an A2A agent). */
  supplier?: SupplierAgent;
  /** Reference knowledge Munshi answers from with citations (official GST rates). */
  knowledge?: KnowledgeBase;
};

const SHOP_FACTS_SHOWN = 12;

/** The owner's shop-wide preferences, so they apply without the model having to look them up. */
async function shopFactsNote(store: KhataStore) {
  const facts = (await store.memories(null)).slice(-SHOP_FACTS_SHOWN);
  return facts.length ? `What the owner asked you to remember about the shop:\n${facts.map((m) => `- ${m.fact}`).join("\n")}` : null;
}

export function createKhataAgent({ model, store, shopName, language, approvalSecret, channel, detectLanguage, extraNote, specialists = true, onRoute, supplier, knowledge }: KhataAgentOptions) {
  // One lookup per turn for each note; every step of the loop reuses it. Failures aren't fatal.
  let shopFacts: Promise<string | null> | undefined;
  let languageRule: Promise<string | null> | undefined;
  const replyRule = (messages: ModelMessage[]) => {
    languageRule ??= (async () => {
      const text = latestOwnerText(messages);
      const detected = text && detectLanguage ? await detectLanguage(text).catch(() => null) : null;
      return detected ? replyLanguageRule(detected) : null;
    })();
    return languageRule;
  };
  // Which customers and products the owner's words name, from the shop's own records. Both the
  // router and the desk get it, so neither has to guess whether "akki" is a person or rice.
  let mentions: Promise<Mention[]> | undefined;
  const mentionsFor = (messages: ModelMessage[]) => {
    mentions ??= (async () => {
      const text = latestOwnerText(messages);
      if (!text) return [];
      const [customers, products] = await Promise.all([store.listCustomers(), store.listProducts()]);
      return findMentions(text, customers, products);
    })().catch(() => []);
    return mentions;
  };
  let route: Promise<Route> | undefined;
  const routeFor = (messages: ModelMessage[]) => {
    route ??= specialists
      ? mentionsFor(messages)
          .then((found) => routeMessage(model, messages, asksForQr(messages), mentionsHint(found)))
          .then((r) => (onRoute?.(r), r))
      : Promise.resolve<Route>({ desk: "general", by: "fallback", ms: 0, tokens: 0 });
    return route;
  };

  return new ToolLoopAgent({
    model,
    instructions: deskInstructions("general", shopName, language, channel),
    tools: { ...createKhataTools(store, shopName, { supplier, knowledge }), handOff: handOffTool },
    // Money only moves after the owner says yes; approvals are HMAC-signed so a
    // client cannot forge one.
    toolApproval: { sendPaymentLink: "user-approval", placeSupplierOrder: "user-approval" },
    experimental_toolApprovalSecret: approvalSecret,
    stopWhen: isStepCount(8),
    telemetry: { functionId: "munshi-agent" }, // names the agent's spans in Langfuse when tracing is on
    prepareStep: async ({ stepNumber, messages }) => {
      // The model follows the recent chat over rules at the top of the prompt, so the reply
      // language and the freshness rule are the last thing it reads. The freshness rule stops once
      // this turn has a tool result: shown on every step, the model kept re-calling tools until the
      // step limit and never answered. The desk, language and shop facts are looked up together.
      shopFacts ??= shopFactsNote(store).catch(() => null);
      const [rule, facts, routed, found] = await Promise.all([replyRule(messages), shopFacts, routeFor(messages), mentionsFor(messages)]);
      const fresh = hasResultThisTurn(messages) ? null : FRESH_FIGURES_RULE;
      const recordIt = reportsEntry(latestOwnerText(messages)) && !entrySettledThisTurn(messages);
      const note = [facts, mentionsNote(found), recordIt ? RECORD_IT_NOTE : null, fresh, rule, extraNote].filter(Boolean).join("\n");

      // A desk that got the wrong message passes it on once; the turn then stays at that desk.
      const handedOff = handedOffTo(messages);
      const desk: Desk = handedOff ?? routed.desk;
      // Force the tool for QR requests: in live testing the model said "QR ready" without calling
      // it. An owner showing a customer a QR that doesn't exist is not something to leave to a prompt.
      // (Sarvam rejects naming a tool in tool_choice, so offer only this tool and require a call.)
      const forceQr = stepNumber === 0 && asksForQr(messages);
      // A hand-off means a tool is needed, so the desk that receives it must call one.
      const mustAct = forceQr || justHandedOff(messages);
      return {
        ...(note ? { model: withClosingNote(model, note) } : {}),
        // Without the old figures to copy, the model has to look them up again.
        ...(stepNumber === 0 ? { messages: forgetOldToolResults(messages) } : {}),
        instructions: deskInstructions(desk, shopName, language, channel),
        activeTools: forceQr ? ["showPaymentQr" as const] : deskTools(desk, !handedOff),
        ...(mustAct ? { toolChoice: "required" as const } : {}),
      };
    },
  });
}

export type KhataAgent = ReturnType<typeof createKhataAgent>;
/** Owner messages say if they were spoken; replies say which desk answered. */
export type KhataMessageMetadata = { source?: "voice"; desk?: Desk };
export type KhataUIMessage = InferAgentUIMessage<KhataAgent, KhataMessageMetadata>;
