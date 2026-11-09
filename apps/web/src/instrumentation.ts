// Traces every model call, agent step and tool call to Langfuse. Without LANGFUSE_* keys it stays off.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) return;

  const [{ registerOTel }, { LangfuseSpanProcessor }, { LangfuseVercelAiSdkIntegration }, { registerTelemetry }, { setTraceExporter }] = await Promise.all([
    import("@vercel/otel"),
    import("@langfuse/otel"),
    import("@langfuse/vercel-ai-sdk"),
    import("ai"),
    import("@/lib/telemetry"),
  ]);
  const processor = new LangfuseSpanProcessor({
    // Serverless functions freeze after the response, so send spans as they end, not in batches.
    exportMode: process.env.VERCEL ? "immediate" : "batched",
    environment: process.env.VERCEL_ENV ?? "development",
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
  });
  setTraceExporter(processor);
  registerOTel({ serviceName: "munshi-web", spanProcessors: [processor] });
  // AI SDK 7 has no built-in tracing: integrations turn its lifecycle events into spans.
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
}
