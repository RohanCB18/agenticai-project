import { expect, it } from "vitest";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { completedActions, receiptLines } from "../src/receipts";
import { MemoryStore } from "../src/testing/memory-store";

// What the live audit of a brand-new shop found broken, asked of real Sarvam: goods the shop
// doesn't have yet, and fixing a wrong entry (live, the fix was recorded as a second expense).
//   npm run eval -w @munshi/agents -- fixes     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;

async function say(store: MemoryStore, text: string) {
  const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "Test Shop", language: "hi", channel: "app" });
  const result = await agent.generate({ messages: [{ role: "user", content: text }] });
  const calls = result.steps.flatMap((s) => s.toolCalls.map((c) => `${c.toolName}(${JSON.stringify(c.input)})`));
  console.log(`> ${text}\n  tools: ${calls.join(", ") || "-"}\n  receipts: ${receiptLines(completedActions(result.responseMessages)).join(" | ") || "-"}\n  reply: ${result.text.trim()}`);
  return result;
}

async function shopWithRamesh() {
  const store = new MemoryStore();
  await store.addCustomer({ name: "Ramesh", phone: "9999999999" });
  return store;
}

it.skipIf(!key)("adds goods a new shop doesn't have yet, with the stock that arrived", { timeout: 120_000 }, async () => {
  const store = new MemoryStore();
  await say(store, "20 packet Maggi aaye");
  expect(store.products.map((p) => [p.name.toLowerCase(), p.stockQty, p.unit.toLowerCase()])).toEqual([["maggi", 20, expect.stringMatching(/^(pkt|packet|packets|pack)$/)]]);
});

it.skipIf(!key)("changes a wrong expense instead of adding another", { timeout: 120_000 }, async () => {
  const store = new MemoryStore();
  await store.addLedgerEntry({ kind: "expense", amountPaise: 80000, note: "bijli ka bill" });
  await say(store, "Galti ho gayi, bijli ka bill 800 nahi 600 tha. Theek kar do");
  expect(store.entries.map((e) => [e.kind, e.amountPaise])).toEqual([["expense", 60000]]);
});

it.skipIf(!key)("fixes a customer's udhaar amount", { timeout: 120_000 }, async () => {
  const store = await shopWithRamesh();
  await store.addLedgerEntry({ kind: "credit_given", amountPaise: 45000, customerId: store.customers[0]!.id });
  await say(store, "Ramesh ka 450 galat likha tha, 400 ka saaman liya tha");
  expect(store.entries.map((e) => [e.kind, e.amountPaise])).toEqual([["credit_given", 40000]]);
});

it.skipIf(!key)("removes a sale recorded by mistake", { timeout: 120_000 }, async () => {
  const store = new MemoryStore();
  await store.addLedgerEntry({ kind: "sale", amountPaise: 150000 });
  await say(store, "Abhi jo 1500 ki sale likhi woh galat hai, hata do");
  expect(store.entries).toHaveLength(0);
});

it.skipIf(!key)("tells a shop with no products there is nothing to tag", { timeout: 120_000 }, async () => {
  const store = new MemoryStore();
  const result = await say(store, "Saare products ka HSN laga do");
  expect(result.text).not.toMatch(/pehle se|already/i);
});
