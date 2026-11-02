import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createKhataAgent } from "./khata-agent";
import { withFallback } from "./models";
import { MemoryStore } from "./testing/memory-store";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function toolCall(toolName: string, input: object): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: `call_${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function text(t: string): LanguageModelV4GenerateResult {
  return { content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
}

/** A fake model that plays back a fixed script of responses, one per step. */
function scripted(...steps: LanguageModelV4GenerateResult[]) {
  let i = 0;
  return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(i++, steps.length - 1)]! });
}

async function seededStore() {
  const store = new MemoryStore();
  await store.addCustomer({ name: "Ramesh", phone: "+919800000001" });
  return store;
}

describe("khata agent loop", () => {
  it("calls recordCredit and then answers", async () => {
    const store = await seededStore();
    const agent = createKhataAgent({
      model: scripted(toolCall("recordCredit", { customerName: "Ramesh", amount: 450 }), text("Ramesh ka ₹450 likh diya.")),
      store,
      shopName: "Test Stores",
      language: "hi",
    });

    const result = await agent.generate({ prompt: "Ramesh ne 450 ka saaman liya" });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({ kind: "credit_given", amountPaise: 45000 });
    expect(result.text).toContain("450");
  });

  it("stops for owner approval before sending a payment link", async () => {
    const store = await seededStore();
    await store.addLedgerEntry({ kind: "credit_given", amountPaise: 43000, customerId: store.customers[0]!.id });
    const agent = createKhataAgent({
      model: scripted(toolCall("sendPaymentLink", { customerName: "Ramesh" }), text("Link bhej diya.")),
      store,
      shopName: "Test Stores",
      language: "hi",
    });

    const result = await agent.generate({ prompt: "Ramesh ko payment link bhejo" });

    expect(result.content.some((p) => p.type === "tool-approval-request")).toBe(true);
    expect(store.links).toHaveLength(0); // nothing sent until the owner approves
  });
});

describe("Sarvam to Claude fallback", () => {
  it("uses the fallback when the primary model errors", async () => {
    const sarvam = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("503 model_overloaded");
      },
    });
    const claude = scripted(text("fallback answer"));
    const errors: unknown[] = [];
    const store = await seededStore();
    const agent = createKhataAgent({ model: withFallback(sarvam, claude, (e) => errors.push(e)), store, shopName: "T", language: "en" });

    const result = await agent.generate({ prompt: "hello" });

    expect(result.text).toBe("fallback answer");
    expect(errors).toHaveLength(1);
  });
});
