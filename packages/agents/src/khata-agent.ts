import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Language } from "@munshi/db";
import { isStepCount, ToolLoopAgent, type InferAgentUIMessage } from "ai";
import type { KhataStore } from "./store";
import { createKhataTools } from "./tools";

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
- Reply in the language the owner used. If unclear, use ${LANGUAGE_NAMES[language]}. Code-mixed speech like Hinglish or Kanglish is normal; reply the same way.
- Be brief: one or two short sentences, like a trusted shop assistant. Always say amounts in rupees.
- Never mention tools, JSON or internal ids.

How to work:
- Use tools for every fact about money or stock. Never guess balances or invent customers.
- "X ne 450 ka saaman liya", "X took 450 on credit", "X ge 450 udhaar" means recordCredit.
- "X ne 200 diye", "X paid 200" means recordPayment.
- If a tool reports customer_not_found or ambiguous_customer, ask the owner a short question instead of guessing.
- To collect dues over UPI, use sendPaymentLink. The owner will be asked to approve it. If they deny it, acknowledge and do not retry. If the tool returns a link, it is already approved and sent: confirm it, and never ask for approval again.
- Never record the same entry twice. If the owner repeats themselves, ask whether it is a new entry.${CHANNEL_NOTES[channel]}`;
}

export type KhataAgentOptions = {
  model: LanguageModelV4;
  store: KhataStore;
  shopName: string;
  language: Language;
  approvalSecret?: string;
  channel?: Channel;
};

export function createKhataAgent({ model, store, shopName, language, approvalSecret, channel }: KhataAgentOptions) {
  return new ToolLoopAgent({
    model,
    instructions: khataInstructions(shopName, language, channel),
    tools: createKhataTools(store),
    // Money only moves after the owner says yes; approvals are HMAC-signed so a
    // client cannot forge one.
    toolApproval: { sendPaymentLink: "user-approval" },
    experimental_toolApprovalSecret: approvalSecret,
    stopWhen: isStepCount(8),
  });
}

export type KhataAgent = ReturnType<typeof createKhataAgent>;
export type KhataUIMessage = InferAgentUIMessage<KhataAgent>;
