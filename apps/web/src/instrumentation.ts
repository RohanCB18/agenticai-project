import { registerOTel } from "@vercel/otel";

// Exports AI SDK and agent spans to Langfuse. Without LANGFUSE_* keys tracing stays off.
export async function register() {
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) return;

  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const langfuseSpanProcessor = new LangfuseSpanProcessor({
    exportMode: process.env.VERCEL ? "immediate" : "batched",
  });
  registerOTel({ serviceName: "munshi-web", spanProcessors: [langfuseSpanProcessor] });
}
