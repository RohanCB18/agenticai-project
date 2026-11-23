import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { MemoryStore } from "../src/testing/memory-store";
import { approvalResponse, pendingApprovals } from "../src/threads";

// A payment link with real Sarvam, through the owner's button. Live, the button said "their full
// balance" (no amount), and replies said "Owner ise forward kar sakte hain" to the owner.
//   npm run eval -w @munshi/agents -- approvals     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;
const CLAIMS_DONE = /bhej diya|bhej di|bhej dia|sent|ho gaya|ready hai|taiyaar hai|ಕಳುಹಿಸಲಾಗಿದೆ|ಕಳಿಸಿದ/i;

for (const text of ["Ramesh ko payment link bhejo", "ರಮೇಶ್‌ಗೆ ಪೇಮೆಂಟ್ ಲಿಂಕ್ ಕಳುಹಿಸು"]) {
  it.skipIf(!key)(text, { timeout: 180_000 }, async () => {
    const store = new MemoryStore();
    const ramesh = await store.addCustomer({ name: "Ramesh", phone: "9999999999", aliases: ["ರಮೇಶ್"] });
    await store.addLedgerEntry({ kind: "credit_given", amountPaise: 65000, customerId: ramesh.id });
    const agent = () => createKhataAgent({ model: sarvamModel(key!), store, shopName: "RCB general stores", language: "kn", channel: "telegram", approvalSecret: "eval-only-secret" });

    let messages: ModelMessage[] = [{ role: "user", content: text }];
    const asked = await agent().generate({ messages });
    messages = [...messages, ...asked.responseMessages];
    const [approval] = pendingApprovals(messages);
    console.log(`> ${text}\n  button: ${approval?.toolName} ${approval?.reason ?? "(no amount)"}\n  before the tap: ${asked.text.trim() || "(nothing)"}`);
    expect(approval).toMatchObject({ toolName: "sendPaymentLink", reason: "₹650 (full balance)" });
    expect(asked.text).not.toMatch(CLAIMS_DONE);

    messages = [...messages, approvalResponse(approval!.approvalId, true)];
    const done = await agent().generate({ messages });
    console.log(`  after the tap: ${done.text.trim()}`);
    expect(store.links).toHaveLength(1);
    expect(done.text).not.toMatch(/\bowner\b/i);
  });
}
