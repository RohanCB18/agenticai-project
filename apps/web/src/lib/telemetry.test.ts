import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { createKhataAgent } from "@munshi/agents";
import { MemoryStore } from "@munshi/agents/testing";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeAll, describe, expect, it } from "vitest";
import { flushTraces, setTraceExporter, traced } from "./telemetry";

// The same wiring as instrumentation.ts, with spans kept in memory instead of sent to Langfuse.
const exporter = new InMemorySpanExporter();
beforeAll(() => {
  const processor = new LangfuseSpanProcessor({ exporter, exportMode: "immediate", publicKey: "pk-test", secretKey: "sk-test", mediaUploadEnabled: false });
  setTraceExporter(processor);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const reply = (text: string): LanguageModelV4GenerateResult => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] });
const call = (toolName: string, input: object): LanguageModelV4GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: `call_${toolName}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

describe("Langfuse tracing", () => {
  it("traces the router, each model call and each tool under the shop and its chat", async () => {
    const store = new MemoryStore();
    await store.addCustomer({ name: "Ramesh", phone: "+919800000001" });
    // The router answers first, then the khata desk calls getBalances and replies.
    const steps = [reply("khata"), call("getBalances", { customerName: "Ramesh" }), reply("Ramesh ka 0 baaki hai.")];
    let i = 0;
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[i++]! });
    const agent = createKhataAgent({ model, store, shopName: "Test", language: "hi" });

    exporter.reset();
    await traced({ merchantId: "shop-1", channel: "telegram", source: "voice" }, () => agent.generate({ messages: [{ role: "user", content: "Ramesh ka kitna baaki hai?" }] }));
    await flushTraces();

    const spans = exporter.getFinishedSpans();
    // The router and the desk agent are separate agent spans; the tool call has its own span.
    expect(spans.map((s) => s.attributes["gen_ai.agent.name"]).filter(Boolean)).toEqual(["desk-router", "munshi-agent"]);
    const tool = spans.find((s) => s.attributes["gen_ai.tool.name"] === "getBalances");
    expect(tool?.attributes["gen_ai.tool.call.arguments"]).toBe('{"customerName":"Ramesh"}');
    expect(spans.filter((s) => s.attributes["gen_ai.operation.name"] === "chat")).toHaveLength(3); // router + two desk steps
    // Every span carries the shop, the chat thread and the tags, so Langfuse groups them.
    for (const span of spans) {
      expect(span.attributes["user.id"]).toBe("shop-1");
      expect(span.attributes["session.id"]).toBe("shop-1:telegram");
      expect(span.attributes["langfuse.trace.tags"]).toEqual(["telegram", "voice"]);
    }
  });

  it("does nothing when tracing is off", async () => {
    setTraceExporter({ forceFlush: async () => Promise.reject(new Error("offline")) });
    await expect(flushTraces()).resolves.toBeUndefined(); // a failed flush is logged, never thrown
    expect(traced({ merchantId: "m", channel: "chat" }, () => 42)).toBe(42);
  });
});
