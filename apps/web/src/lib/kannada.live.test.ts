import { type ChartRunner, completedActions, createKhataAgent, detectLanguage, receiptLines, romanise, sarvamModel } from "@munshi/agents";
import { MemoryStore } from "@munshi/agents/testing";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { configuredKnowledge } from "./knowledge";

// Every feature asked in Kannada, with real Sarvam, real language detection and the real GST
// knowledge base: the right tool, the right effect, and a reply in Kannada. Off by default: set
// KANNADA_LIVE=1 with SARVAM_API_KEY and the knowledge base's keys (see bill-gst.live.test.ts).

const key = process.env.SARVAM_API_KEY;
const knowledge = process.env.KANNADA_LIVE === "1" ? configuredKnowledge() : undefined;

const KANNADA = /[ಀ-೿]/;
const DEVANAGARI = /[ऀ-ॿ]/;

/** A shop as an owner would set it up: names in English, the khata from earlier in the week. */
async function shop() {
  const store = new MemoryStore();
  const ramesh = await store.addCustomer({ name: "Ramesh", phone: "9999999999" });
  const fatima = await store.addCustomer({ name: "Fatima", phone: "9999999998" });
  await store.addCustomer({ name: "Lakshmi" });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 45000, customerId: ramesh.id, note: "saaman" });
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 50000, customerId: fatima.id });
  await store.addLedgerEntry({ kind: "payment_received", amountPaise: 27000, customerId: fatima.id });
  await store.addLedgerEntry({ kind: "expense", amountPaise: 80000, note: "current bill" });
  store.entries.forEach((entry, i) => (entry.createdAt = new Date(Date.now() - (4 - i) * 86_400_000).toISOString()));
  const product = (id: string, name: string, unit: string, stockQty: number, reorderLevel: number | null) =>
    store.products.push({ id, name, aliases: [], unit, stockQty, reorderLevel, pricePaise: null });
  product("rice", "Rice", "kg", 50, 10);
  product("sugar", "Sugar", "kg", 3, 5);
  product("maggi", "Maggi", "pkt", 12, null);
  await store.remember({ fact: "Ramesh is Lakshmi's husband.", customerId: ramesh.id });
  return store;
}

const charts: ChartRunner = { run: async () => ({ ok: true, png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), stdout: "" }) };

type Case = { text: string; tools: string[]; check?: (store: MemoryStore) => void; script?: "kn" | "latin" };
const rameshOwes = (store: MemoryStore) =>
  store.entries.filter((e) => e.customerId === store.customers[0]!.id).reduce((sum, e) => sum + (e.kind === "credit_given" ? e.amountPaise : -e.amountPaise), 0);

const CASES: Case[] = [
  // Khata
  { text: "ರಮೇಶ್ 450 ರೂಪಾಯಿ ಸಾಮಾನು ತಗೊಂಡ", tools: ["recordCredit"], check: (s) => expect(rameshOwes(s)).toBe(90000) },
  { text: "ರಮೇಶ್ ನಾನೂರ ಐವತ್ತು ರೂಪಾಯಿ ಸಾಮಾನು ತಗೊಂಡ", tools: ["recordCredit"], check: (s) => expect(rameshOwes(s)).toBe(90000) },
  { text: "ಫಾತಿಮಾ 200 ರೂಪಾಯಿ ಕೊಟ್ರು", tools: ["recordPayment"] },
  { text: "ಇವತ್ತು 1500 ರೂಪಾಯಿ ವ್ಯಾಪಾರ ಆಯ್ತು", tools: ["recordSale"], check: (s) => expect(s.entries.at(-1)).toMatchObject({ kind: "sale", amountPaise: 150000 }) },
  { text: "ಅಂಗಡಿ ಬಾಡಿಗೆ 5000 ಕೊಟ್ಟೆ", tools: ["recordSale"], check: (s) => expect(s.entries.at(-1)).toMatchObject({ kind: "expense", amountPaise: 500000 }) },
  { text: "ಯಾರ್ಯಾರು ಎಷ್ಟು ಬಾಕಿ ಕೊಡಬೇಕು?", tools: ["getBalances"] },
  { text: "ರಮೇಶ್ ಎಷ್ಟು ಕೊಡಬೇಕು?", tools: ["getBalances"] },
  { text: "ರಮೇಶ್ ಈ ವಾರ ಏನೇನು ತಗೊಂಡ?", tools: ["customerHistory"] },
  // Saved as the owner wrote it ("ಸುರೇಶ್" is fine): matching and Cashfree both romanise it.
  { text: "ಹೊಸ ಗಿರಾಕಿ ಸೇರಿಸು, ಸುರೇಶ್, ನಂಬರ್ 9876543210", tools: ["addCustomer"], check: (s) => expect(s.customers.map((c) => romanise(c.name))).toContain("suresh") },
  { text: "ಲಕ್ಷ್ಮಿ ನಂಬರ್ 9876500000", tools: ["updateCustomer"], check: (s) => expect(s.customers[2]!.phone).toContain("9876500000") },
  { text: "ತಪ್ಪಾಯ್ತು, ಕರೆಂಟ್ ಬಿಲ್ 800 ಅಲ್ಲ, 600", tools: ["correctEntry"], check: (s) => expect(s.entries.filter((e) => e.kind === "expense").map((e) => e.amountPaise)).toEqual([60000]) },
  { text: "ರಮೇಶ್ 200 ಕೊಟ್ಟ, ಈಗ ಎಷ್ಟು ಬಾಕಿ?", tools: ["recordPayment"], check: (s) => expect(rameshOwes(s)).toBe(25000) },
  // Collections
  { text: "ರಮೇಶ್‌ಗೆ ಪೇಮೆಂಟ್ ಲಿಂಕ್ ಕಳುಹಿಸು", tools: ["sendPaymentLink"] },
  { text: "ಫಾತಿಮಾ ಅಂಗಡೀಲಿ ಇದ್ದಾರೆ, QR ತೋರಿಸು", tools: ["showPaymentQr"] },
  { text: "ರಮೇಶ್ ಆನ್‌ಲೈನ್‌ನಲ್ಲಿ ಹಣ ಕಳಿಸಿದ್ನಾ?", tools: ["checkPayment"] },
  // Stock
  { text: "ಅಕ್ಕಿ ಎಷ್ಟು ಇದೆ?", tools: ["getStock"] },
  { text: "10 ಕೆಜಿ ಸಕ್ಕರೆ ಬಂತು", tools: ["updateStock"], check: (s) => expect(s.products.find((p) => p.name === "Sugar")!.stockQty).toBe(13) },
  { text: "ಯಾವ ಸಾಮಾನು ಮುಗೀತಾ ಬಂದಿದೆ?", tools: ["getStock"] },
  { text: "ತೊಗರಿ ಬೇಳೆ ಹೊಸ ಸಾಮಾನು, 25 ಕೆಜಿ ಬಂತು", tools: ["addProduct"], check: (s) => expect(s.products.at(-1)).toMatchObject({ stockQty: 25 }) },
  { text: "ಅಕ್ಕಿ 20 ಕೆಜಿಗೆ ಇಳಿದಾಗ ಹೇಳು", tools: ["setReorderLevel"], check: (s) => expect(s.products[0]!.reorderLevel).toBe(20) },
  // GST
  { text: "ಮ್ಯಾಗಿ ಮೇಲೆ ಎಷ್ಟು ಜಿಎಸ್‌ಟಿ?", tools: ["lookupGst"] },
  { text: "ಎಲ್ಲಾ ಸಾಮಾನಿಗೆ HSN ಹಾಕು", tools: ["tagAllProducts"] },
  // Chart
  { text: "ಈ ತಿಂಗಳ ಮಾರಾಟದ ಚಾರ್ಟ್ ತೋರಿಸು", tools: ["makeChart"] },
  // Memory
  { text: "ನೆನಪಿಟ್ಕೋ, ಫಾತಿಮಾ ಭಾನುವಾರ ಅಂಗಡಿಗೆ ಬರಲ್ಲ", tools: ["remember"] },
  { text: "ರಮೇಶ್ ಬಗ್ಗೆ ಏನು ನೆನಪಿದೆ?", tools: ["recall"] },
  // Chit-chat: nothing may change
  { text: "ನಮಸ್ಕಾರ", tools: [] },
  { text: "ಧನ್ಯವಾದ", tools: [] },
  // Kannada in English letters
  { text: "Ramesh 300 rupayi saaman togondru", tools: ["recordCredit"], script: "latin" },
  { text: "Akki eshtu ide?", tools: ["getStock"], script: "latin" },
];

const WRITES = new Set(["recordCredit", "recordPayment", "recordSale", "addCustomer", "updateCustomer", "correctEntry", "updateStock", "addProduct", "setReorderLevel", "remember", "tagAllProducts"]);

describe.skipIf(!knowledge || !key)("Munshi in Kannada", () => {
  for (const c of CASES) {
    it(c.text, { timeout: 120_000 }, async () => {
      const store = await shop();
      const agent = createKhataAgent({
        model: sarvamModel(key!),
        store,
        shopName: "Ganesh Stores",
        language: "kn",
        channel: "telegram",
        approvalSecret: "test-only-secret",
        detectLanguage: (text) => detectLanguage({ apiKey: key!, text }),
        knowledge,
        charts,
      });
      const messages: ModelMessage[] = [{ role: "user", content: c.text }];
      const result = await agent.generate({ messages });
      const called = result.steps.flatMap((s) => s.toolCalls.map((call) => call.toolName));
      const reply = result.text.trim();
      console.log(`> ${c.text}\n  tools: ${called.join(", ") || "-"}\n  receipts: ${receiptLines(completedActions(result.responseMessages)).join(" | ") || "-"}\n  reply: ${reply}`);

      for (const tool of c.tools) expect(called).toContain(tool);
      if (c.tools.length === 0) expect(called.filter((t) => WRITES.has(t))).toEqual([]);
      c.check?.(store);
      // An approval waits for the button, so that turn may end without words.
      if (reply) {
        expect(reply).not.toMatch(DEVANAGARI);
        if (c.script === "latin") expect(reply).not.toMatch(KANNADA);
        else expect(reply).toMatch(KANNADA);
      }
    });
  }
});
