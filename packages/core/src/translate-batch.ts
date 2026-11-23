import pRetry from "p-retry";

import { estimateInputTokens } from "./batch.js";
import { selectGlossaryForText, type Glossary, type GlossaryStats } from "./glossary.js";
import { buildPrompt, parseResponse, type BuiltPrompt } from "./prompt.js";
import type { Segment } from "./segment.js";
import { isPermanentProviderError, type ProviderResponseInfo, type Translator } from "./translator.js";

/** Options for translating and validating one provider request. */
export interface TranslateBatchOptions {
  translator: Translator;
  segments: Segment[];
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  context?: string | undefined;
  documentContext?: string | undefined;
  promptInstruction?: string | undefined;
  /** See `GlossaryMatchOptions`. Not part of the glossary, so it doesn't change glossary hashes. */
  matchInflections?: boolean | undefined;
  maxRetries?: number;
  onRetry?: ((event: TranslateBatchRetryEvent) => void) | undefined;
  onBatchAttempt?: ((event: TranslateBatchAttemptEvent) => void) | undefined;
  retryMinTimeoutMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  signal?: AbortSignal | undefined;
}

/** A failed provider attempt that will be retried. */
export interface TranslateBatchRetryEvent {
  attempt: number;
  totalAttempts: number;
  error: Error;
}

/** Prompts, normalized response, and parsing outcome for one provider attempt. */
export interface TranslateBatchAttemptEvent {
  attempt: number;
  totalAttempts: number;
  modelId: string;
  segments: Segment[];
  estimatedInputTokens: number;
  sourceCharacters: number;
  systemPrompt: string;
  userPrompt: string;
  /** The glossary terms this batch's prompt carried, out of all of them. */
  glossary: GlossaryStats;
  /** What the provider reported about the reply, when it reports anything. */
  providerResponse?: ProviderResponseInfo | undefined;
  response?: string | undefined;
  translations?: Map<string, string> | undefined;
  durationMs: number;
  error?: unknown;
}

/** The prompt one batch sends: only the glossary terms that appear in its segments or document context. */
export function buildBatchPrompt(
  options: Pick<
    TranslateBatchOptions,
    "segments" | "glossary" | "sourceLocale" | "targetLocale" | "context" | "documentContext" | "promptInstruction" | "matchInflections"
  >,
): BuiltPrompt & { glossaryStats: GlossaryStats } {
  const text = [...options.segments.map((segment) => segment.text), options.documentContext ?? ""].join("\n");
  const selected = selectGlossaryForText(options.glossary, text, { matchInflections: options.matchInflections });
  return { ...buildPrompt({ ...options, glossary: selected.glossary }), glossaryStats: selected.stats };
}

export async function translateBatch(options: TranslateBatchOptions): Promise<Map<string, string>> {
  const {
    translator,
    segments,
    glossary,
    sourceLocale,
    targetLocale,
    context,
    documentContext,
    promptInstruction,
    maxRetries = 0,
    onRetry,
    onBatchAttempt,
    retryMinTimeoutMs = 0,
    retryFactor = 2,
    retryRandomize = false,
    signal,
  } = options;
  if (segments.length === 0) return new Map();

  const { systemPrompt, userPrompt, glossaryStats } = buildBatchPrompt({
    segments,
    glossary,
    sourceLocale,
    targetLocale,
    context,
    documentContext,
    promptInstruction,
    matchInflections: options.matchInflections,
  });
  const expectedIds = segments.map((segment) => segment.id);
  const totalAttempts = Math.max(1, maxRetries + 1);
  let attempt = 0;

  const runAttempt = async (): Promise<Map<string, string>> => {
    signal?.throwIfAborted();
    attempt += 1;
    const startedAt = performance.now();
    let response: string | undefined;
    let providerResponse: ProviderResponseInfo | undefined;
    const event = () => ({
      attempt,
      totalAttempts,
      modelId: translator.modelId,
      segments: segments.map((segment) => ({ ...segment })),
      estimatedInputTokens: estimateInputTokens(segments),
      sourceCharacters: segments.reduce((total, segment) => total + segment.text.length, 0),
      systemPrompt,
      userPrompt,
      glossary: glossaryStats,
      ...(providerResponse === undefined ? {} : { providerResponse }),
      durationMs: performance.now() - startedAt,
    });
    try {
      response = await translator.translate(systemPrompt, userPrompt, signal, (info) => {
        providerResponse = info;
      });
      const translations = parseResponse(response, expectedIds);
      if (onBatchAttempt !== undefined) notifyBatchAttempt(onBatchAttempt, { ...event(), response, translations: new Map(translations) });
      return translations;
    } catch (error) {
      if (onBatchAttempt !== undefined) {
        notifyBatchAttempt(onBatchAttempt, { ...event(), ...(response === undefined ? {} : { response }), error });
      }
      throw attachProviderResponse(error, providerResponse);
    }
  };

  return pRetry(runAttempt, {
    retries: maxRetries,
    minTimeout: retryMinTimeoutMs,
    factor: retryFactor,
    randomize: retryRandomize,
    ...(signal !== undefined ? { signal } : {}),
    shouldRetry: ({ error }) => !isPermanentProviderError(error),
    onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
      if (retriesLeft > 0 && !isPermanentProviderError(error)) {
        onRetry?.({ attempt: attemptNumber, totalAttempts, error });
      }
    },
  });
}

/** Server logs read `providerResponse` off the error, to show why a reply failed without the debug trace. */
function attachProviderResponse(error: unknown, info: ProviderResponseInfo | undefined): unknown {
  if (info !== undefined && error instanceof Error && !Object.hasOwn(error, "providerResponse")) {
    Object.defineProperty(error, "providerResponse", { value: info, enumerable: false });
  }
  return error;
}

function notifyBatchAttempt(callback: (event: TranslateBatchAttemptEvent) => void, event: TranslateBatchAttemptEvent): void {
  try {
    callback(event);
  } catch {
    // Diagnostics must not change translation behavior.
  }
}
