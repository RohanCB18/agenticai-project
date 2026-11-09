import { propagateAttributes } from "@langfuse/tracing";

// Langfuse tracing (see instrumentation.ts). Every helper here is a no-op when tracing is off.

type Flushable = { forceFlush(): Promise<void> };

// On globalThis, because instrumentation.ts and the routes are bundled separately.
const holder = globalThis as { __munshiTraceExporter?: Flushable };

export function setTraceExporter(exporter: Flushable) {
  holder.__munshiTraceExporter = exporter;
}

/** Sends spans still in flight. Await it before a serverless function is frozen (in `after()`). */
export async function flushTraces() {
  try {
    await holder.__munshiTraceExporter?.forceFlush();
  } catch (error) {
    console.warn("[munshi] couldn't send traces to Langfuse:", error instanceof Error ? error.message : error);
  }
}

export type TraceInfo = {
  merchantId: string;
  /** Where the owner wrote: "chat" (web), "telegram" or "whatsapp". One chat thread per shop and channel. */
  channel: string;
  /** "voice" when the owner spoke. */
  source?: string;
  /** Why this run happened besides an owner message, e.g. "retry:unbacked-claim". */
  reason?: string;
};

/**
 * Runs one agent turn as a Langfuse trace: grouped by shop (user) and chat thread (session) and
 * tagged by channel, so a bad reply can be found from the shop and read step by step.
 */
export function traced<T>(info: TraceInfo, run: () => T): T {
  const tags = [info.channel, info.source, info.reason].filter((tag): tag is string => Boolean(tag));
  return propagateAttributes(
    { userId: info.merchantId, sessionId: `${info.merchantId}:${info.channel}`, tags, traceName: info.reason ? `${info.channel} ${info.reason}` : `${info.channel} message` },
    run,
  );
}
