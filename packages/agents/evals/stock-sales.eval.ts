import { expect, it } from "vitest";
import { endsWithQuestion } from "../src/desks";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { detectLanguage } from "../src/voice";
import { seededStore } from "./cases";

// A sale that names its goods must lower their stock, or a low item never gets its restock ask.
// Against real Sarvam, each case twice, one at a time (Sarvam rate-limits bursts):
//   node --env-file=../../apps/web/.env.local ../../node_modules/vitest/vitest.mjs run --config vitest.evals.config.ts evals/stock-sales.eval.ts

const key = process.env.SARVAM_API_KEY;
const REPEATS = Number(process.env.EVAL_REPEATS ?? 2);

// noQuestion: the reply must not ask for the amount, so the restock ask goes out right after it.
type Case = { text: string; must: string[]; mustNot: string[]; noQuestion?: boolean };
const CASES: Case[] = [
  { text: "Sugar 2 kg bik gaya", must: ["updateStock"], mustNot: [], noQuestion: true },
  { text: "3 packet Maggi bike", must: ["updateStock"], mustNot: [], noQuestion: true },
  { text: "2 kg chawal 120 mein becha", must: ["updateStock", "recordSale"], mustNot: [] },
  { text: "Ramesh ne 2 kg chawal liya, 120 ka", must: ["recordCredit", "updateStock"], mustNot: [] },
  // No goods named: the stock must not move.
  { text: "Ramesh ne 450 ka saaman liya", must: ["recordCredit"], mustNot: ["updateStock"] },
  { text: "Aaj 1200 ki bikri hui", must: ["recordSale"], mustNot: ["updateStock"] },
];

it.skipIf(!key)("lowers stock for sales that name their goods, and only those", { timeout: 600_000 }, async () => {
  const rows: { text: string; called: string[]; pass: boolean; reply: string }[] = [];
  for (let round = 0; round < REPEATS; round++) {
    for (const c of CASES) {
      const store = await seededStore();
      const agent = createKhataAgent({
        model: sarvamModel(key!),
        store,
        shopName: "Sri Ganesh Stores",
        language: "hi",
        channel: "telegram",
        approvalSecret: "eval-only-secret",
        detectLanguage: (text) => detectLanguage({ apiKey: key!, text }),
      });
      let called: string[] = [];
      let reply = "";
      try {
        const result = await agent.generate({ messages: [{ role: "user", content: c.text }] });
        called = [...new Set(result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)))];
        reply = result.text.trim();
      } catch (error) {
        reply = `ERROR ${error instanceof Error ? error.message : String(error)}`;
      }
      const pass = c.must.every((tool) => called.includes(tool)) && !c.mustNot.some((tool) => called.includes(tool)) && !(c.noQuestion && endsWithQuestion(reply));
      rows.push({ text: c.text, called, pass, reply: reply.slice(0, 140) });
      console.log(`${pass ? "PASS" : "FAIL"} | ${c.text} | ${called.join(" > ") || "none"} | ${reply.slice(0, 140).replace(/\n/g, " ")}`);
    }
  }
  const passed = rows.filter((r) => r.pass).length;
  console.log(`stock-sales: ${passed}/${rows.length}`);
  expect(passed).toBe(rows.length);
});
