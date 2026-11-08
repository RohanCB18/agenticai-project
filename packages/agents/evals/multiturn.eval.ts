import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import type { Route } from "../src/desks";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { seededStore } from "./cases";

// One chat that moves between desks, so later turns carry tool calls the current desk doesn't
// offer. Checks that each turn routes, acts and answers, and that the khata ends up right.

const key = process.env.SARVAM_API_KEY;

const TURNS: { text: string; expect: string[] }[] = [
  { text: "Ramesh ne 450 ka saaman liya", expect: ["recordCredit"] },
  { text: "Chawal kitna bacha hai?", expect: ["getStock"] },
  { text: "Fatima ka QR dikhao", expect: ["showPaymentQr"] },
  { text: "Ramesh ne 200 cash diye", expect: ["recordPayment"] },
  { text: "Ramesh ka kitna baaki hai ab?", expect: ["getBalances"] },
  // Live, right after a balance reply, every desk took "Akki" (rice) for a customer's name.
  { text: "Akki eshtu ide", expect: ["getStock"] },
  { text: "Thank you", expect: [] },
];

it.skipIf(!key)("a chat that moves between desks", { timeout: 600_000 }, async () => {
  const store = await seededStore();
  store.products[0]!.aliases = []; // like the live shop: Rice has no "akki" alias
  let messages: ModelMessage[] = [];
  const misses: string[] = [];
  for (const turn of TURNS) {
    let route: Route | undefined;
    const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "Sri Ganesh Stores", language: "hi", channel: "telegram", onRoute: (r) => void (route = r) });
    messages = [...messages, { role: "user", content: turn.text }];
    const result = await agent.generate({ messages });
    messages = [...messages, ...result.responseMessages];
    const tools = result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    const ok = turn.expect.every((tool) => tools.includes(tool));
    if (!ok) misses.push(turn.text);
    console.log(`${ok ? "ok  " : "MISS"} ${turn.text} -> ${route?.desk} | ${tools.join(",") || "-"} | ${result.text.trim().slice(0, 90)}`);
  }
  // 450 before, +450 credit, -200 cash.
  const [ramesh] = await store.balances(store.customers[0]!.id);
  expect(ramesh?.outstandingPaise).toBe(70000);
  expect(misses).toEqual([]);
});
