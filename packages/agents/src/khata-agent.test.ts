import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { asksForQr, createKhataAgent, FRESH_FIGURES_RULE, replyLanguageRule } from "./khata-agent";
import { ModelTimeoutError, retryOnTimeout, unstreamForcedToolCalls, withFallback, withTimeout } from "./models";
import { MemoryStore } from "./testing/memory-store";
import { closePendingApprovals } from "./threads";

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

describe("an approval the owner never answered", () => {
  it("doesn't break the next turn", async () => {
    // Live: a turn after a link approval was cut off before the thread was saved, so the saved
    // thread ended on the request. Every message after it failed with "Tool result is missing".
    const store = await seededStore();
    const history: ModelMessage[] = [
      { role: "user", content: "Ramesh ko link bhejo" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "chatcmpl-tool-1", toolName: "sendPaymentLink", input: { customerName: "Ramesh" } },
          { type: "tool-approval-request", approvalId: "appr_1", toolCallId: "chatcmpl-tool-1" },
        ],
      },
    ];
    const agent = createKhataAgent({ model: scripted(text("Namaste")), store, shopName: "T", language: "en", specialists: false });

    const result = await agent.generate({ messages: [...closePendingApprovals(history), { role: "user", content: "Ramesh ko link bhejo" }] });

    expect(result.text).toBe("Namaste");
    expect(store.links).toHaveLength(0); // the request the owner moved on from never runs
  });
});

describe("reply language", () => {
  it("names the language and script of the owner's message", () => {
    expect(replyLanguageRule({ languageCode: "kn-IN", scriptCode: "Latn" })).toContain("Kannada, written in English letters");
    expect(replyLanguageRule({ languageCode: "kn-IN", scriptCode: "Knda" })).toContain("Kannada, in its own script");
    expect(replyLanguageRule({ languageCode: "en-IN", scriptCode: "Latn" })).toContain("only in English");
    expect(replyLanguageRule({ languageCode: "xx-IN", scriptCode: "Latn" })).toBeNull();
  });

  it("makes the rule the last thing the model reads on every step, once per turn", async () => {
    const store = await seededStore();
    const lastMessages: unknown[] = [];
    const steps = [toolCall("getBalances", {}), text("Ramesh ge 0 baaki ide")];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        lastMessages.push(options.prompt.at(-1));
        return steps[lastMessages.length - 1]!;
      },
    });
    let detections = 0;
    const agent = createKhataAgent({
      model,
      store,
      shopName: "Test",
      language: "hi",
      specialists: false,
      detectLanguage: async () => (detections++, { languageCode: "kn-IN", scriptCode: "Latn" }),
    });

    const result = await agent.generate({ messages: [{ role: "user", content: "Ramesh eshtu baaki ide?" }] });

    expect(detections).toBe(1);
    expect(lastMessages).toHaveLength(2);
    for (const message of lastMessages) expect(message).toMatchObject({ role: "system", content: expect.stringContaining("Kannada") });
    // The rule is for the model call only: it never joins the saved conversation.
    expect(JSON.stringify(result.responseMessages)).not.toContain("written in English letters");
  });

  it("asks for fresh figures until this turn has a tool result, then stops asking", async () => {
    const store = await seededStore();
    const notes: string[] = [];
    const steps = [toolCall("getBalances", {}), text("Ramesh ka 0 baaki hai")];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const last = options.prompt.at(-1);
        notes.push(last?.role === "system" ? last.content : "");
        return steps[notes.length - 1]!;
      },
    });
    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi", specialists: false });
    await agent.generate({ messages: [{ role: "user", content: "Ramesh ka kitna baaki hai?" }] });

    expect(notes[0]).toContain(FRESH_FIGURES_RULE);
    // Repeated after the lookup, the rule made the model call tools until the step limit.
    expect(notes[1]).not.toContain(FRESH_FIGURES_RULE);
  });

  it("carries on without a rule if detection fails", async () => {
    const store = await seededStore();
    const agent = createKhataAgent({
      model: scripted(text("Theek hai")),
      store,
      shopName: "Test",
      language: "hi",
      detectLanguage: async () => {
        throw new Error("Sarvam is down");
      },
    });
    const result = await agent.generate({ messages: [{ role: "user", content: "hello" }] });
    expect(result.text).toBe("Theek hai");
  });
});

describe("QR requests", () => {
  it("recognises QR in the scripts speech-to-text uses", () => {
    for (const text of ["Anand ka QR dikhao", "आनंद का क्यूआर दिखाओ", "ಆನಂದ್ ಕ್ಯೂಆರ್ ತೋರಿಸು", "show the qr"]) {
      expect(asksForQr([{ role: "user", content: text }])).toBe(true);
    }
    expect(asksForQr([{ role: "user", content: "Ramesh ne 200 diye" }])).toBe(false);
    expect(asksForQr([{ role: "assistant", content: "QR ready" }])).toBe(false);
  });

  it("forces the QR tool on the first step only, so the model can't claim one it didn't make", async () => {
    const store = await seededStore();
    await store.addLedgerEntry({ kind: "credit_given", amountPaise: 9500, customerId: store.customers[0]!.id });
    const seen: { toolChoice: unknown; tools: string[] }[] = [];
    const steps = [toolCall("showPaymentQr", { customerName: "Ramesh" }), text("QR ready hai")];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push({ toolChoice: options.toolChoice, tools: (options.tools ?? []).map((t) => t.name) });
        return steps[seen.length - 1]!;
      },
    });

    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi" });
    await agent.generate({ messages: [{ role: "user", content: "Ramesh ka QR dikhao" }] });

    expect(seen[0]).toEqual({ toolChoice: { type: "required" }, tools: ["showPaymentQr"] });
    expect(seen[1]?.toolChoice).not.toEqual({ type: "required" });
    expect(seen[1]?.tools.length).toBeGreaterThan(1);
    expect(store.qrs).toHaveLength(1);
  });

  it("runs forced steps without streaming and streams the rest", async () => {
    const calls: string[] = [];
    const model = unstreamForcedToolCalls(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls.push("generate");
          return text("ok");
        },
        doStream: async () => {
          calls.push("stream");
          return { stream: new ReadableStream() };
        },
      }),
    );
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

    await model.doStream({ prompt, toolChoice: { type: "required" } });
    await model.doStream({ prompt, toolChoice: { type: "auto" } });
    expect(calls).toEqual(["generate", "stream"]);
  });
});

describe("khata agent loop", () => {
  it("calls recordCredit and then answers", async () => {
    const store = await seededStore();
    const agent = createKhataAgent({
      model: scripted(toolCall("recordCredit", { customerName: "Ramesh", amount: 450 }), text("Ramesh ka ₹450 likh diya.")),
      store,
      shopName: "Test Stores",
      language: "hi",
      specialists: false,
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
      specialists: false,
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
    const agent = createKhataAgent({ model: withFallback(sarvam, claude, (e) => errors.push(e)), store, shopName: "T", language: "en", specialists: false });

    const result = await agent.generate({ prompt: "hello" });

    expect(result.text).toBe("fallback answer");
    expect(errors).toHaveLength(1);
  });

  /** A model that never answers, like the live Sarvam call that hung a turn: only an abort ends it. */
  const stalled = () =>
    new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise<LanguageModelV4GenerateResult>((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason))),
    });

  it("fails a call that doesn't answer in time, instead of hanging the turn", async () => {
    const agent = createKhataAgent({ model: withTimeout(stalled(), 30), store: await seededStore(), shopName: "T", language: "en", specialists: false });
    await expect(agent.generate({ prompt: "hello" })).rejects.toThrow("didn't answer within 0.03 s");
  });

  /** Stalls on the first `stalls` calls, then answers: how a stuck Sarvam request looks. */
  function stallsThenAnswers(stalls: number, answer: string) {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        ++calls <= stalls
          ? new Promise<LanguageModelV4GenerateResult>((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal!.reason)))
          : Promise.resolve(text(answer)),
    });
    return { model, calls: () => calls };
  }

  it("asks Sarvam once more when a call stalls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sarvam = stallsThenAnswers(1, "second try");
    const agent = createKhataAgent({ model: retryOnTimeout(withTimeout(sarvam.model, 30)), store: await seededStore(), shopName: "T", language: "en", specialists: false });

    expect((await agent.generate({ prompt: "hello" })).text).toBe("second try");
    expect(sarvam.calls()).toBe(2);
    warn.mockRestore();
  });

  it("gives up after a second stall, so the turn can tell the owner", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sarvam = stallsThenAnswers(2, "never");
    const agent = createKhataAgent({ model: retryOnTimeout(withTimeout(sarvam.model, 30)), store: await seededStore(), shopName: "T", language: "en", specialists: false });

    await expect(agent.generate({ prompt: "hello" })).rejects.toBeInstanceOf(ModelTimeoutError);
    expect(sarvam.calls()).toBe(2);
    warn.mockRestore();
  });

  it("doesn't retry an error that isn't a stall", async () => {
    let calls = 0;
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        throw new Error("400 bad request");
      },
    });
    const agent = createKhataAgent({ model: retryOnTimeout(withTimeout(failing, 1000)), store: await seededStore(), shopName: "T", language: "en", specialists: false });

    await expect(agent.generate({ prompt: "hello" })).rejects.toThrow("400 bad request");
    expect(calls).toBe(1);
  });

  it("leaves a call that answers in time alone", async () => {
    const agent = createKhataAgent({ model: withTimeout(scripted(text("on time")), 1000), store: await seededStore(), shopName: "T", language: "en", specialists: false });
    expect((await agent.generate({ prompt: "hello" })).text).toBe("on time");
  });
});

describe("specialist desks", () => {
  /** A model that answers the router with `desk` and plays `steps` for the desk agent. */
  function deskModel(desk: string, steps: LanguageModelV4GenerateResult[]) {
    const seen: { tools: string[]; instructions: string; toolChoice: unknown }[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const system = options.prompt[0]?.role === "system" ? options.prompt[0].content : "";
        if (system.startsWith("You route")) return text(desk);
        seen.push({ tools: (options.tools ?? []).map((t) => t.name).sort(), instructions: system, toolChoice: options.toolChoice });
        return steps[seen.length - 1]!;
      },
    });
    return { model, seen };
  }

  it("gives the routed desk only its own tools and rules", async () => {
    const store = await seededStore();
    const { model, seen } = deskModel("stock", [toolCall("getStock", {}), text("Chawal 50 kg hai")]);
    const routes: string[] = [];
    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi", onRoute: (r) => routes.push(r.desk) });
    await agent.generate({ messages: [{ role: "user", content: "Chawal kitna hai?" }] });

    expect(routes).toEqual(["stock"]);
    expect(seen[0]?.tools).toEqual([
      "askSupplierQuote",
      "forget",
      "getStock",
      "handOff",
      "lookupGst",
      "placeSupplierOrder",
      "recall",
      "recordSale",
      "remember",
      "setReorderLevel",
      "updateStock",
    ]);
    expect(seen[0]?.instructions).toContain("stock desk");
    expect(seen[0]?.instructions).not.toContain("sendPaymentLink");
  });

  it("lets a desk hand a message on once, then works with the new desk's tools", async () => {
    const store = await seededStore();
    const { model, seen } = deskModel("stock", [
      toolCall("handOff", { desk: "khata" }),
      toolCall("recordCredit", { customerName: "Ramesh", amount: 450 }),
      text("Ramesh ka 450 likh diya"),
    ]);
    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi" });
    await agent.generate({ messages: [{ role: "user", content: "Ramesh ne 450 ka saaman liya" }] });

    expect(seen[1]?.tools).toContain("recordCredit");
    expect(seen[1]?.tools).not.toContain("handOff"); // no passing it around in circles
    expect(seen[1]?.toolChoice).toEqual({ type: "required" }); // the new desk acts, it doesn't just reply
    expect(seen[2]?.toolChoice).not.toEqual({ type: "required" });
    expect(seen[1]?.instructions).toContain("khata desk");
    expect(store.entries.at(-1)).toMatchObject({ kind: "credit_given", amountPaise: 45000 });
  });

  it("falls back to the general desk, with every tool, when the router's answer is unusable", async () => {
    const store = await seededStore();
    const { model, seen } = deskModel("I am not sure", [text("Namaste!")]);
    const routes: { desk: string; by: string }[] = [];
    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi", onRoute: (r) => routes.push(r) });
    await agent.generate({ messages: [{ role: "user", content: "Namaste" }] });

    expect(routes).toMatchObject([{ desk: "general", by: "fallback" }]);
    expect(seen[0]?.tools).toContain("sendPaymentLink");
    expect(seen[0]?.tools).toContain("getStock");
    expect(seen[0]?.tools).not.toContain("handOff");
  });
});
