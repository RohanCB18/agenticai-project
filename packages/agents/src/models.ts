import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";

export const SARVAM_MODEL = "sarvam-105b";
export const DEFAULT_FALLBACK_MODEL = "claude-opus-5-5";

export type ModelConfig = {
  sarvamApiKey?: string;
  anthropicApiKey?: string;
  fallbackModel?: string;
};

/** Sarvam's V2 chat API is OpenAI-compatible but authenticates with `api-subscription-key`. */
export function sarvamModel(apiKey: string): LanguageModelV4 {
  const sarvam = createOpenAICompatible({
    name: "sarvam",
    baseURL: "https://api.sarvam.ai/v2",
    headers: { "api-subscription-key": apiKey },
    includeUsage: true,
    // Sarvam's documented defaults for these disagree across pages, so pin them.
    transformRequestBody: (body) => ({
      ...body,
      reasoning_effort: body.reasoning_effort ?? "low",
      temperature: body.temperature ?? 0.2,
      max_tokens: body.max_tokens ?? 4096,
    }),
  });
  return unstreamForcedToolCalls(sarvam.chatModel(SARVAM_MODEL));
}

/**
 * When a tool call is forced while streaming, Sarvam sends it back as raw text
 * ("<tool_call>showPaymentQr...") instead of a tool call, so nothing runs. Those steps call
 * the API without streaming and replay the result as a stream; everything else streams normally.
 */
export function unstreamForcedToolCalls(model: LanguageModelV4): LanguageModelV4 {
  const unstreamed = wrapLanguageModel({ model, middleware: simulateStreamingMiddleware() });
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => model.doGenerate(options),
    doStream: (options) => (options.toolChoice?.type === "required" ? unstreamed.doStream(options) : model.doStream(options)),
  };
}

export function claudeModel(apiKey: string, modelId = DEFAULT_FALLBACK_MODEL): LanguageModelV4 {
  return createAnthropic({ apiKey })(modelId);
}

/**
 * Tries the primary model and switches to the fallback if the primary call fails
 * before any output is produced (bad key, rate limit, Sarvam 502/503, network).
 * Once a stream has started we stay on it, so the user never sees two half-answers.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4, onFallback?: (error: unknown) => void): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: `${primary.provider}+fallback`,
    modelId: primary.modelId,
    supportedUrls: primary.supportedUrls,
    async doGenerate(options) {
      try {
        return await primary.doGenerate(options);
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        onFallback?.(error);
        return fallback.doGenerate(options);
      }
    },
    async doStream(options) {
      try {
        return await primary.doStream(options);
      } catch (error) {
        if (options.abortSignal?.aborted) throw error;
        onFallback?.(error);
        return fallback.doStream(options);
      }
    },
  };
}

export class ModelTimeoutError extends Error {
  constructor(modelId: string, ms: number) {
    super(`${modelId} didn't answer within ${ms / 1000} s`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * How long one Sarvam call may take before it is asked again. Steps normally take 2-5 s; live, one
 * never answered and the turn hung until Vercel stopped it at 60 s with nothing said to the owner.
 * Two tries fit inside a turn's time (see TURN_BUDGET_MS in the web app's conversation.ts).
 */
export const SARVAM_CALL_TIMEOUT_MS = 15_000;

/**
 * Fails a call that hasn't answered within `ms`. For a stream that means the first response: once
 * it is streaming it is left to finish.
 */
export function withTimeout(model: LanguageModelV4, ms: number): LanguageModelV4 {
  async function limited<T>(options: Parameters<LanguageModelV4["doGenerate"]>[0], call: (options: Parameters<LanguageModelV4["doGenerate"]>[0]) => PromiseLike<T>) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(new ModelTimeoutError(model.modelId, ms)), ms);
    const abortSignal = options.abortSignal ? AbortSignal.any([options.abortSignal, timer.signal]) : timer.signal;
    try {
      return await call({ ...options, abortSignal });
    } catch (error) {
      throw timer.signal.aborted ? timer.signal.reason : error;
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => limited(options, (o) => model.doGenerate(o)),
    doStream: (options) => limited(options, (o) => model.doStream(o)),
  };
}

/**
 * Asks once more when a call timed out (ModelTimeoutError from withTimeout). Munshi runs on Sarvam
 * alone, so a stuck request is retried rather than handed to another model. Other errors are left
 * to the AI SDK's own retries (rate limits, 5xx), and nothing is retried once the turn is out of time.
 */
export function retryOnTimeout(model: LanguageModelV4): LanguageModelV4 {
  async function again<T>(options: Parameters<LanguageModelV4["doGenerate"]>[0], call: (options: Parameters<LanguageModelV4["doGenerate"]>[0]) => PromiseLike<T>) {
    try {
      return await call(options);
    } catch (error) {
      if (!(error instanceof ModelTimeoutError) || options.abortSignal?.aborted) throw error;
      console.warn(`[munshi] ${error.message}; asking once more`);
      return call(options);
    }
  }
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => again(options, (o) => model.doGenerate(o)),
    doStream: (options) => again(options, (o) => model.doStream(o)),
  };
}

/** Sarvam with a time limit per call, and one more try when a call stalls. */
function reliableSarvam(apiKey: string) {
  return retryOnTimeout(withTimeout(sarvamModel(apiKey), SARVAM_CALL_TIMEOUT_MS));
}

export class MissingModelKeyError extends Error {
  constructor() {
    super("No language model is configured. Add SARVAM_API_KEY (and ideally ANTHROPIC_API_KEY as a fallback) to apps/web/.env.local.");
    this.name = "MissingModelKeyError";
  }
}

/**
 * Sarvam, retried once when a call stalls. Production runs on Sarvam alone; an ANTHROPIC_API_KEY,
 * if one is ever set, adds Claude behind it. Whichever keys exist decide the chain.
 */
export function resolveModel(config: ModelConfig, onFallback?: (error: unknown) => void): LanguageModelV4 {
  const { sarvamApiKey, anthropicApiKey, fallbackModel } = config;
  if (sarvamApiKey && anthropicApiKey) {
    return withFallback(reliableSarvam(sarvamApiKey), claudeModel(anthropicApiKey, fallbackModel), onFallback);
  }
  if (sarvamApiKey) return reliableSarvam(sarvamApiKey);
  if (anthropicApiKey) return claudeModel(anthropicApiKey, fallbackModel);
  throw new MissingModelKeyError();
}
