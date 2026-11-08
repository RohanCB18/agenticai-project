import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { deskInstructions, deskTools, handedOffTo, routeMessage } from "./desks";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A router model that answers `desk` and remembers what it was asked. */
function router(desk: string) {
  const prompts: LanguageModelV4CallOptions["prompt"][] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return { content: [{ type: "text", text: desk }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
  return { model, prompts };
}

const promptText = (prompt: LanguageModelV4CallOptions["prompt"]) => JSON.stringify(prompt.filter((m) => m.role === "user"));

describe("routeMessage", () => {
  it("skips the model for approvals and QR requests", async () => {
    const { model, prompts } = router("stock");
    const approval: ModelMessage[] = [{ role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] }];
    expect(await routeMessage(model, approval, false)).toMatchObject({ desk: "general", by: "approval" });
    expect(await routeMessage(model, [{ role: "user", content: "Fatima ka QR dikhao" }], true)).toMatchObject({ desk: "collections", by: "qr" });
    expect(prompts).toHaveLength(0);
  });

  it("shows Munshi's last words only when the owner just answers them", async () => {
    const { model, prompts } = router("collections");
    const asked: ModelMessage[] = [
      { role: "user", content: "Ramesh ka kitna baaki hai?" },
      { role: "assistant", content: "Ramesh ka 450 baaki hai. Link bhejun?" },
    ];
    await routeMessage(model, [...asked, { role: "user", content: "haan bhejo" }], false);
    await routeMessage(model, [...asked, { role: "user", content: "Chawal kitna bacha hai abhi?" }], false);
    expect(promptText(prompts[0]!)).toContain("Link bhejun?");
    expect(promptText(prompts[1]!)).not.toContain("Link bhejun?");
  });

  it("ignores Munshi's last words when it didn't ask anything", async () => {
    // Live: after this balance reply, "Akki eshtu ide" went to the khata desk.
    const { model, prompts } = router("stock");
    await routeMessage(
      model,
      [
        { role: "user", content: "Ramesh ne 200 diye, ab kitna baaki hai?" },
        { role: "assistant", content: "Ramesh ka balance 0 rupaye hai." },
        { role: "user", content: "Akki eshtu ide" },
      ],
      false,
      '"akki" is the product Rice',
    );
    expect(promptText(prompts[0]!)).not.toContain("balance");
    expect(promptText(prompts[0]!)).toContain("akki");
    expect(promptText(prompts[0]!)).toContain("the product Rice");
  });

  it("falls back to general when the model fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("429 rate limit");
      },
    });
    expect(await routeMessage(model, [{ role: "user", content: "Namaste" }], false)).toMatchObject({ desk: "general", by: "fallback" });
  });
});

describe("desks", () => {
  it("give each specialist only its own rules", () => {
    const khata = deskInstructions("khata", "Test", "hi");
    expect(khata).toContain("khata desk");
    expect(khata).toContain("recordCredit");
    expect(khata).not.toContain("sendPaymentLink");
    const general = deskInstructions("general", "Test", "hi");
    for (const tool of ["recordCredit", "sendPaymentLink", "showPaymentQr", "updateStock", "remember"]) expect(general).toContain(tool);
    expect(general).not.toContain("handOff");
  });

  it("offer a hand-off only before one has happened", () => {
    expect(deskTools("stock", true)).toContain("handOff");
    expect(deskTools("stock", false)).not.toContain("handOff");
    expect(deskTools("general", true)).not.toContain("handOff");
  });

  it("only count a hand-off from the current turn", () => {
    const handOff = (desk: string): ModelMessage => ({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "h1", toolName: "handOff", output: { type: "json", value: { status: "handed_off", desk } } }],
    });
    expect(handedOffTo([{ role: "user", content: "Ramesh ne 200 diye" }, handOff("khata")])).toBe("khata");
    expect(handedOffTo([handOff("khata"), { role: "user", content: "Chawal kitna hai?" }])).toBeNull();
  });
});
