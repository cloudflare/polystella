import pRetry from "p-retry";

import type { Glossary } from "./glossary.js";
import { buildPrompt, parseResponse } from "./prompt.js";
import type { Segment } from "./segment.js";
import { isPermanentProviderError, type Translator } from "./translator.js";

export interface TranslateBatchOptions {
  translator: Translator;
  segments: Segment[];
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  context?: string | undefined;
  documentContext?: string | undefined;
  maxRetries?: number;
  onRetry?: ((event: TranslateBatchRetryEvent) => void) | undefined;
  retryMinTimeoutMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  signal?: AbortSignal | undefined;
}

export interface TranslateBatchRetryEvent {
  attempt: number;
  totalAttempts: number;
  error: Error;
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
    maxRetries = 0,
    onRetry,
    retryMinTimeoutMs = 0,
    retryFactor = 2,
    retryRandomize = false,
    signal,
  } = options;
  if (segments.length === 0) return new Map();

  const { systemPrompt, userPrompt } = buildPrompt({
    segments,
    glossary,
    sourceLocale,
    targetLocale,
    context,
    documentContext,
  });
  const expectedIds = segments.map((segment) => segment.id);
  const totalAttempts = Math.max(1, maxRetries + 1);

  return pRetry(
    async () => {
      signal?.throwIfAborted();
      const rawText = await translator.translate(systemPrompt, userPrompt, signal);
      return parseResponse(rawText, expectedIds);
    },
    {
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
    },
  );
}
