import type { ModelMessage } from "ai";
import { expect, it } from "vitest";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import { MemoryStore } from "../src/testing/memory-store";
import { pendingApprovals } from "../src/threads";
import { detectLanguage } from "../src/voice";

// Paying a supplier with real Sarvam, over two turns as on Telegram. Live, Munshi asked "poora
// 3,900 payment karun?" and every "haan" after it went to a desk that can't pay a supplier: four
// empty replies, and no button. The answer must lead to paySupplier and the owner's button, for
// the ₹100 the owner named (once fixed, "haan" paid the whole ₹3,900 Munshi had asked about).
//   npm run eval -w @munshi/agents -- pay-supplier     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;

async function shop() {
  const store = new MemoryStore();
  store.suppliers = [{ id: "sup_1", name: "SHARMA TRADERS", aliases: [], account: "UPI su•••@upi", verified: true }];
  const order = (orderId: string, totalPaise: number) => ({
    supplier: "SHARMA TRADERS",
    orderId,
    quoteId: `q_${orderId}`,
    lines: [],
    total: `₹${totalPaise / 100}`,
    totalPaise,
    deliverySlot: "Tomorrow 9-11 am",
    payment: "Pay on delivery",
  });
  store.supplierOrders = [order("ST-1", 260000), order("ST-2", 130000)];
  return store;
}

for (const answer of ["haan", "HAA", "Haan, pay karo."]) {
  it.skipIf(!key)(`"${answer}" after Munshi asks to pay the supplier`, { timeout: 180_000 }, async () => {
    const store = await shop();
    const agent = () =>
      createKhataAgent({
        model: sarvamModel(key!),
        store,
        shopName: "RCB general stores",
        language: "hi",
        channel: "telegram",
        approvalSecret: "eval-only-secret",
        detectLanguage: (text) => detectLanguage({ apiKey: key!, text }),
      });

    let messages: ModelMessage[] = [{ role: "user", content: "Sharma Traders ko 100 rupaye payment kar do" }];
    const first = await agent().generate({ messages });
    messages = [...messages, ...first.responseMessages];
    const firstTools = first.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    let approvals = pendingApprovals(messages);
    console.log(`> Sharma Traders ko 100 rupaye payment kar do\n  tools: ${firstTools.join(", ")}\n  reply: ${first.text.trim()}`);

    // If Munshi asked first (it should, after showing what is due), the owner says yes.
    if (approvals.length === 0) {
      messages = [...messages, { role: "user", content: answer }];
      const second = await agent().generate({ messages });
      messages = [...messages, ...second.responseMessages];
      approvals = pendingApprovals(messages);
      console.log(`> ${answer}\n  tools: ${second.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)).join(", ") || "-"}\n  reply: ${second.text.trim() || "(waiting for the button)"}`);
    }
    console.log(`  button: ${approvals.map((a) => `${a.toolName} ${JSON.stringify(a.input)}`).join(", ") || "none"}`);
    expect(firstTools).toContain("supplierDues");
    // The owner said 100: live, Munshi asked about the whole ₹3,900 instead, and "haan" paid that.
    expect(approvals[0]).toMatchObject({ toolName: "paySupplier", input: { amount: 100 } });
  });
}
