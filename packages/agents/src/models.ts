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

export class MissingModelKeyError extends Error {
  constructor() {
    super("No language model is configured. Add SARVAM_API_KEY (and ideally ANTHROPIC_API_KEY as a fallback) to apps/web/.env.local.");
    this.name = "MissingModelKeyError";
  }
}

/** Sarvam first, Claude as fallback; whichever keys exist decide the chain. */
export function resolveModel(config: ModelConfig, onFallback?: (error: unknown) => void): LanguageModelV4 {
  const { sarvamApiKey, anthropicApiKey, fallbackModel } = config;
  if (sarvamApiKey && anthropicApiKey) {
    return withFallback(sarvamModel(sarvamApiKey), claudeModel(anthropicApiKey, fallbackModel), onFallback);
  }
  if (sarvamApiKey) return sarvamModel(sarvamApiKey);
  if (anthropicApiKey) return claudeModel(anthropicApiKey, fallbackModel);
  throw new MissingModelKeyError();
}
