import pRetry from "p-retry";

import { packGroupsIntoBatches } from "../batch.js";
import type { Glossary } from "../glossary.js";
import { assertUniqueSegmentIds, type Segment } from "../segment.js";
import { translateBatch, type TranslateBatchRetryEvent } from "../translate-batch.js";
import { isPermanentProviderError, type Translator } from "../translator.js";

const TOKEN_RE = /\{\{(\w+)\}\}/g;

export const DEFAULT_UI_STRING_BATCH_SIZE = 25;

export function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match[1] !== undefined) tokens.add(match[1]);
  }
  return tokens;
}

export interface TokenValidationIssue {
  key: string;
  missing: string[];
  spurious: string[];
}

export function validateTokenPreservation(key: string, source: string, translation: string): TokenValidationIssue | null {
  const sourceTokens = extractTokens(source);
  const translationTokens = extractTokens(translation);
  const missing = [...sourceTokens].filter((token) => !translationTokens.has(token)).sort();
  const spurious = [...translationTokens].filter((token) => !sourceTokens.has(token)).sort();
  return missing.length === 0 && spurious.length === 0 ? null : { key, missing, spurious };
}

export interface CatalogTranslationEntry {
  key: string;
  source: string;
}

export type EmptyKeyPair = CatalogTranslationEntry;

export function selectEmptyKeys(sourceDict: Record<string, string>, localeDict: Record<string, string>): EmptyKeyPair[] {
  const pairs: EmptyKeyPair[] = [];
  for (const [key, source] of Object.entries(sourceDict)) {
    if (source.length > 0 && (!Object.hasOwn(localeDict, key) || !localeDict[key])) pairs.push({ key, source });
  }
  return pairs;
}

export function withTokenPreservationRule(glossary: Glossary): Glossary {
  return {
    ...glossary,
    styleRules: [
      ...glossary.styleRules,
      {
        category: "placeholders",
        instruction:
          "Preserve every `{{token}}` placeholder verbatim - same name, same braces, same position relative to the surrounding text. Do not translate, rename, or remove them.",
        example: "Copyright ©{{year}}. -> Copyright ©{{year}}.",
      },
    ],
  };
}

export interface CatalogTranslationOptions {
  translator: Translator;
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  context?: string | undefined;
  maxRetries?: number | undefined;
  retryMinTimeoutMs?: number | undefined;
  retryFactor?: number | undefined;
  retryRandomize?: boolean | undefined;
  inputTokenBudget?: number | undefined;
  maxSegmentsPerBatch?: number | undefined;
  signal?: AbortSignal | undefined;
  onRetry?: ((event: TranslateBatchRetryEvent) => void) | undefined;
}

export interface TranslateCatalogEntriesOptions extends CatalogTranslationOptions {
  entries: readonly CatalogTranslationEntry[];
}

export interface TranslateCatalogEntriesResult {
  translations: Map<string, string>;
  tokenFailures: TokenValidationIssue[];
  batchCount: number;
}

export interface TranslateUiStringsOptions extends CatalogTranslationOptions {
  sourceDict: Record<string, string>;
  localeDict: Record<string, string>;
}

export interface TranslateUiStringsResult {
  dict: Record<string, string>;
  filled: string[];
  tokenFailures: TokenValidationIssue[];
  batchCount: number;
}

export async function translateCatalogEntries(opts: TranslateCatalogEntriesOptions): Promise<TranslateCatalogEntriesResult> {
  assertUniqueSegmentIds(opts.entries.map(({ key }) => key));
  const entries = opts.entries.filter(({ source }) => source.length > 0);
  if (entries.length === 0) return { translations: new Map(), tokenFailures: [], batchCount: 0 };

  const keysById = new Map<string, string>();
  const segments = entries.map(({ key, source }, index) => {
    const id = `catalog:${index}`;
    keysById.set(id, key);
    return { id, text: source };
  });
  const batches = packUiStringBatches(segments, opts);
  const glossary = withTokenPreservationRule(opts.glossary);
  const translations = new Map<string, string>();
  const tokenFailures: TokenValidationIssue[] = [];

  for (const segments of batches) {
    opts.signal?.throwIfAborted();
    const result = await translateUiBatchWithRetries({ ...opts, segments, glossary, keysById });
    const failedKeys = new Set(result.tokenFailures.map(({ key }) => key));
    for (const [id, text] of result.translations) {
      const key = keysById.get(id);
      if (key === undefined) throw new Error(`[polystella] missing catalog key for internal segment id "${id}"`);
      if (!failedKeys.has(key)) translations.set(key, text);
    }
    tokenFailures.push(...result.tokenFailures);
  }

  return { translations, tokenFailures, batchCount: batches.length };
}

export async function translateUiStringsForLocale(opts: TranslateUiStringsOptions): Promise<TranslateUiStringsResult> {
  const emptyKeys = selectEmptyKeys(opts.sourceDict, opts.localeDict);
  const dict = { ...opts.localeDict };
  if (emptyKeys.length === 0) return { dict, filled: [], tokenFailures: [], batchCount: 0 };

  const result = await translateCatalogEntries({ ...opts, entries: emptyKeys });
  const failedKeys = new Set(result.tokenFailures.map(({ key }) => key));
  const filled: string[] = [];
  for (const { key } of emptyKeys) {
    const value = result.translations.get(key);
    if (!failedKeys.has(key) && value !== undefined) {
      dict[key] = value;
      filled.push(key);
    }
  }

  return { dict, filled: filled.sort(), tokenFailures: result.tokenFailures, batchCount: result.batchCount };
}

function packUiStringBatches(
  segments: Segment[],
  opts: Pick<CatalogTranslationOptions, "inputTokenBudget" | "maxSegmentsPerBatch">,
): Segment[][] {
  const tokenBatches = packGroupsIntoBatches(
    segments.map((segment) => [segment]),
    opts.inputTokenBudget === undefined ? {} : { inputTokenBudget: opts.inputTokenBudget },
  );
  const requestedMax = opts.maxSegmentsPerBatch ?? DEFAULT_UI_STRING_BATCH_SIZE;
  const maxSegments = Number.isFinite(requestedMax) ? Math.max(1, Math.floor(requestedMax)) : DEFAULT_UI_STRING_BATCH_SIZE;
  const batches: Segment[][] = [];

  for (const tokenBatch of tokenBatches) {
    for (let index = 0; index < tokenBatch.length; index += maxSegments) {
      batches.push(tokenBatch.slice(index, index + maxSegments));
    }
  }
  return batches;
}

type TranslateUiBatchOptions = Pick<
  CatalogTranslationOptions,
  | "translator"
  | "sourceLocale"
  | "targetLocale"
  | "context"
  | "maxRetries"
  | "retryMinTimeoutMs"
  | "retryFactor"
  | "retryRandomize"
  | "signal"
  | "onRetry"
> & {
  segments: Segment[];
  glossary: Glossary;
  keysById: ReadonlyMap<string, string>;
};

interface TranslateUiBatchResult {
  translations: Map<string, string>;
  tokenFailures: TokenValidationIssue[];
}

class TokenValidationError extends Error {
  constructor(
    readonly translations: Map<string, string>,
    readonly issues: TokenValidationIssue[],
  ) {
    super(
      `[polystella] token-preservation validation failed for ${issues.length} key(s): ${issues
        .map(({ key, missing, spurious }) => `${key} (missing: [${missing.join(", ")}], spurious: [${spurious.join(", ")}])`)
        .join("; ")}`,
    );
    this.name = "TokenValidationError";
  }
}

class RetriableTypeError extends Error {
  constructor(readonly originalError: TypeError) {
    super(originalError.message, { cause: originalError });
    this.name = "RetriableTypeError";
  }
}

async function translateUiBatchWithRetries(opts: TranslateUiBatchOptions): Promise<TranslateUiBatchResult> {
  const maxRetries = opts.maxRetries ?? 0;
  const totalAttempts = Math.max(1, maxRetries + 1);

  try {
    const translations = await pRetry(
      async () => {
        try {
          const result = await translateBatch({
            translator: opts.translator,
            segments: opts.segments,
            glossary: opts.glossary,
            sourceLocale: opts.sourceLocale,
            targetLocale: opts.targetLocale,
            maxRetries: 0,
            ...(opts.context === undefined ? {} : { context: opts.context }),
            ...(opts.signal === undefined ? {} : { signal: opts.signal }),
          });
          const issues = opts.segments.flatMap((segment) => {
            const translation = result.get(segment.id);
            if (translation === undefined) return [];
            const key = opts.keysById.get(segment.id);
            if (key === undefined) throw new Error(`[polystella] missing catalog key for internal segment id "${segment.id}"`);
            const issue = validateTokenPreservation(key, segment.text, translation);
            return issue === null ? [] : [issue];
          });
          if (issues.length > 0) throw new TokenValidationError(result, issues);
          return result;
        } catch (error) {
          throw error instanceof TypeError && !isPermanentProviderError(error) ? new RetriableTypeError(error) : error;
        }
      },
      {
        retries: maxRetries,
        minTimeout: opts.retryMinTimeoutMs ?? 0,
        factor: opts.retryFactor ?? 2,
        randomize: opts.retryRandomize ?? false,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        shouldRetry: ({ error }) => !isPermanentProviderError(error),
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
          if (retriesLeft > 0 && !isPermanentProviderError(error)) {
            opts.onRetry?.({
              attempt: attemptNumber,
              totalAttempts,
              error: error instanceof RetriableTypeError ? error.originalError : error,
            });
          }
        },
      },
    );
    return { translations, tokenFailures: [] };
  } catch (error) {
    if (error instanceof TokenValidationError) {
      return { translations: error.translations, tokenFailures: error.issues };
    }
    if (error instanceof RetriableTypeError) throw error.originalError;
    throw error;
  }
}
