import { expect, it } from "vitest";
import { createKhataAgent } from "../src/khata-agent";
import { sarvamModel } from "../src/models";
import type { QuoteRequestItem, SupplierAgent, SupplierQuote } from "../src/supplier";
import { MemoryStore } from "../src/testing/memory-store";

// The owner asking the wholesaler something through Munshi, with real Sarvam on Munshi's side:
// it must go to askWholesaler (the wholesaler's own order desk), and Munshi must pass on the
// desk's answer without adding prices of its own. The desk here is scripted; its own Sarvam is
// checked in services/distributor (test_live_sarvam_desk) and over A2A (wholesaler-desk.live.test.ts).
//   npm run eval -w @munshi/agents -- ask-wholesaler     (needs SARVAM_API_KEY)

const key = process.env.SARVAM_API_KEY;
const DESK = "Ghee abhi out of stock hai, agle Somvar tak aa jayega. Basmati nahi rakhte, Sona Masoori Rice hai: 25 kg ₹1,300.";

class Desk implements SupplierAgent {
  readonly name = "Sharma Traders";
  questions: string[] = [];
  async quote(_items: QuoteRequestItem[]): Promise<SupplierQuote> {
    throw new Error("not quoted in this eval");
  }
  async order(): Promise<never> {
    throw new Error("not ordered in this eval");
  }
  async ask(question: string) {
    this.questions.push(question);
    return { answer: DESK };
  }
}

for (const said of ["Sharma Traders se poocho ghee kab aayega", "Wholesaler ke paas basmati hai kya?", "ಶರ್ಮಾ ಟ್ರೇಡರ್ಸ್ ಹತ್ರ ತುಪ್ಪ ಯಾವಾಗ ಬರುತ್ತೆ ಕೇಳಿ"]) {
  it.skipIf(!key)(`"${said}" goes to the wholesaler's order desk`, { timeout: 180_000 }, async () => {
    const store = new MemoryStore();
    store.suppliers = [{ id: "sup_1", name: "SHARMA TRADERS", aliases: [], account: "UPI su•••@upi", verified: true }];
    const desk = new Desk();
    const agent = createKhataAgent({ model: sarvamModel(key!), store, shopName: "RCB general stores", language: "hi", channel: "telegram", supplier: desk });
    const result = await agent.generate({ messages: [{ role: "user", content: said }] });
    const tools = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    console.log(`> ${said}\n  tools: ${tools.join(", ") || "-"}\n  asked: ${desk.questions.join(" | ")}\n  reply: ${result.text.trim()}`);
    expect(tools).toContain("askWholesaler");
    expect(desk.questions).toHaveLength(1);
    // No price the desk didn't give: the only one it gave is ₹1,300.
    for (const price of result.text.match(/₹\s?[\d,]+/g) ?? []) expect(price.replace(/\s/g, "")).toBe("₹1,300");
  });
}
