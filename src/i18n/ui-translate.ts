/**
 * UI-string AI translation — fills empty placeholders in non-default
 * locale JSON files via the same provider stack the markdown pipeline
 * uses, but at a much smaller scale: ~118 keys × N locales, all
 * tiny short strings.
 *
 * Three pure helpers + one batched orchestrator:
 *   - `extractTokens` — set of `{{name}}` placeholders in a string
 *   - `validateTokenPreservation` — same set source vs. translation
 *   - `selectEmptyKeys` — pairs that need translating
 *   - `translateUiStringsForLocale` — one or more `translateBatch`
 *     round-trips per locale, plus a post-hoc token validator that
 *     re-throws to trigger the existing retry loop.
 *
 * Token preservation matters because the runtime `interpolate()`
 * (`i18n/translate.ts`) replaces `{{name}}` with caller-supplied
 * params — a dropped or mangled token silently breaks the page.
 * The validator is wired as a final check inside the retry surface,
 * not as a prompt-only instruction.
 */

import type { Glossary } from "../glossary/glossary.js";
import type { Segment } from "../parsing/extract.js";
import { packGroupsIntoBatches } from "../translation/batch.js";
import type { Translator } from "../translation/provider.js";
import { translateBatch, type TranslateBatchRetryEvent } from "../translation/provider.js";

/**
 * `{{token}}` extractor. The runtime grammar in `translate.ts` uses
 * `\w+` (word chars only — letters, digits, underscore), so we match
 * that for parity. Whitespace inside the braces is rejected by the
 * runtime; we reject it here too so a translation introducing
 * `{{ year }}` fails validation.
 */
const TOKEN_RE = /\{\{(\w+)\}\}/g;

/**
 * UI strings are short, so token-budget packing alone can still put
 * too many response items in one provider call. Keep requests small
 * enough that providers don't time out on large catalogs.
 */
export const DEFAULT_UI_STRING_BATCH_SIZE = 25;

/**
 * Set of distinct token names appearing in `text`. Empty for strings
 * without any `{{...}}` placeholders.
 */
export function extractTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    if (match[1] !== undefined) out.add(match[1]);
  }
  return out;
}

export interface TokenValidationIssue {
  key: string;
  /** Tokens in source but absent from the translation. */
  missing: string[];
  /** Tokens in the translation but absent from the source. */
  spurious: string[];
}

/**
 * Compare token sets. Returns `null` if the translation preserves
 * every source token verbatim (and adds none extra); otherwise a
 * structured issue. The orchestrator wraps a returned issue in a
 * plain `Error` so its retry loop picks it up.
 */
export function validateTokenPreservation(key: string, source: string, translation: string): TokenValidationIssue | null {
  const sourceTokens = extractTokens(source);
  const translationTokens = extractTokens(translation);
  const missing = [...sourceTokens].filter((t) => !translationTokens.has(t));
  const spurious = [...translationTokens].filter((t) => !sourceTokens.has(t));
  if (missing.length === 0 && spurious.length === 0) return null;
  return { key, missing: missing.sort(), spurious: spurious.sort() };
}

export interface EmptyKeyPair {
  key: string;
  /** Source-locale value (always non-empty by `selectEmptyKeys`). */
  source: string;
}

/**
 * Find every key where the source has a non-empty value AND the
 * locale's value is `""`. Intentionally-blank source strings (empty
 * in `en-US.json`) are skipped — there's nothing to translate, and
 * the empty intent should propagate verbatim.
 */
export function selectEmptyKeys(sourceDict: Record<string, string>, localeDict: Record<string, string>): EmptyKeyPair[] {
  const out: EmptyKeyPair[] = [];
  for (const [key, source] of Object.entries(sourceDict)) {
    if (source.length === 0) continue;
    const existing = localeDict[key];
    if (existing === undefined || existing.length === 0) {
      out.push({ key, source });
    }
  }
  return out;
}

/**
 * Append a `{{token}}`-preservation style rule to a glossary in
 * memory so the system prompt instructs the model to keep
 * placeholders verbatim. Cheap layer-1 defence; the post-hoc
 * validator is the load-bearing one.
 *
 * Pure: returns a new glossary, doesn't mutate.
 */
export function withTokenPreservationRule(glossary: Glossary): Glossary {
  return {
    ...glossary,
    styleRules: [
      ...glossary.styleRules,
      {
        category: "placeholders",
        instruction:
          "Preserve every `{{token}}` placeholder verbatim — same name, same braces, same position relative to the surrounding text. Do not translate, rename, or remove them.",
        example: "Copyright ©{{year}}. -> Copyright ©{{year}}.",
      },
    ],
  };
}

export interface TranslateUiStringsOptions {
  translator: Translator;
  /** Glossary for the target locale (token-preservation rule is appended internally). */
  glossary: Glossary;
  /** Source-locale dict (typically `en-US`). */
  sourceDict: Record<string, string>;
  /** Existing locale dict; empty values flag keys for translation. */
  localeDict: Record<string, string>;
  sourceLocale: string;
  targetLocale: string;
  /** Optional system-prompt extension forwarded to `buildPrompt`. */
  context?: string | undefined;
  /** Same default as `translateBatch`; tests pass `0`. */
  maxRetries?: number;
  retryMinTimeoutMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  /** Soft cap on per-batch input tokens; defaults applied in batch.ts. */
  inputTokenBudget?: number;
  /** Max UI-string segments per provider request. Defaults to 25. */
  maxSegmentsPerBatch?: number;
  signal?: AbortSignal;
  /** Fires after each failed attempt that triggers another retry. */
  onRetry?: (event: TranslateBatchRetryEvent) => void;
}

export interface TranslateUiStringsResult {
  /** Post-translation locale dict (input + AI fills). */
  dict: Record<string, string>;
  /**
   * Keys for which translation succeeded AND passed token validation.
   * Sorted alphabetically for deterministic logging.
   */
  filled: string[];
  /**
   * Keys for which translation came back token-invalid even after
   * all retries — value left empty so a human can intervene.
   */
  tokenFailures: TokenValidationIssue[];
  /** Number of provider requests dispatched for this locale. */
  batchCount: number;
}

/**
 * Translate every empty-valued key in `localeDict` whose source is
 * non-empty. Large catalogs are split into sequential provider
 * requests by input-token budget and max UI-string count. The token
 * validator runs after each request's `parseResponse`; on failure we
 * throw a plain Error so the local retry loop re-issues that batch —
 * sampling variance is what makes attempt N+1 succeed.
 *
 * Token failures that survive all retries are reported, NOT fatal:
 * the key is left empty and the caller surfaces the list. Hard-
 * failing here would mean a single stubborn key blocks the whole
 * locale; better to land the wins and flag the misses.
 */
export async function translateUiStringsForLocale(opts: TranslateUiStringsOptions): Promise<TranslateUiStringsResult> {
  const empties = selectEmptyKeys(opts.sourceDict, opts.localeDict);
  const dict: Record<string, string> = { ...opts.localeDict };
  if (empties.length === 0) {
    return { dict, filled: [], tokenFailures: [], batchCount: 0 };
  }

  const segments: Segment[] = empties.map(({ key, source }) => ({ id: key, text: source }));
  const batches = packUiStringBatches(segments, {
    ...(opts.inputTokenBudget !== undefined ? { inputTokenBudget: opts.inputTokenBudget } : {}),
    ...(opts.maxSegmentsPerBatch !== undefined ? { maxSegmentsPerBatch: opts.maxSegmentsPerBatch } : {}),
  });
  const glossaryWithRule = withTokenPreservationRule(opts.glossary);

  const translations = new Map<string, string>();
  const tokenFailures: TokenValidationIssue[] = [];

  for (const batch of batches) {
    opts.signal?.throwIfAborted();
    const result = await translateUiBatchWithRetries({
      segments: batch,
      translator: opts.translator,
      glossary: glossaryWithRule,
      sourceLocale: opts.sourceLocale,
      targetLocale: opts.targetLocale,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.retryMinTimeoutMs !== undefined ? { retryMinTimeoutMs: opts.retryMinTimeoutMs } : {}),
      ...(opts.retryFactor !== undefined ? { retryFactor: opts.retryFactor } : {}),
      ...(opts.retryRandomize !== undefined ? { retryRandomize: opts.retryRandomize } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onRetry !== undefined ? { onRetry: opts.onRetry } : {}),
    });
    for (const [id, text] of result.translations) {
      translations.set(id, text);
    }
    tokenFailures.push(...result.tokenFailures);
  }

  // Apply: for every empty pair, if the model returned a token-valid
  // translation, write it. Token-invalid keys stay empty.
  const failedKeys = new Set(tokenFailures.map((f) => f.key));
  const filled: string[] = [];
  for (const { key } of empties) {
    if (failedKeys.has(key)) continue;
    const value = translations.get(key);
    if (value !== undefined) {
      dict[key] = value;
      filled.push(key);
    }
  }
  filled.sort();

  return { dict, filled, tokenFailures, batchCount: batches.length };
}

interface PackUiStringBatchesOptions {
  inputTokenBudget?: number;
  maxSegmentsPerBatch?: number;
}

function packUiStringBatches(segments: Segment[], opts: PackUiStringBatchesOptions): Segment[][] {
  const tokenBatches = packGroupsIntoBatches(
    segments.map((segment) => [segment]),
    {
      ...(opts.inputTokenBudget !== undefined ? { inputTokenBudget: opts.inputTokenBudget } : {}),
    },
  );
  const requestedMax = opts.maxSegmentsPerBatch ?? DEFAULT_UI_STRING_BATCH_SIZE;
  const maxSegments = Number.isFinite(requestedMax) ? Math.max(1, Math.floor(requestedMax)) : DEFAULT_UI_STRING_BATCH_SIZE;
  const batches: Segment[][] = [];

  for (const tokenBatch of tokenBatches) {
    for (let i = 0; i < tokenBatch.length; i += maxSegments) {
      batches.push(tokenBatch.slice(i, i + maxSegments));
    }
  }

  return batches;
}

interface TranslateUiBatchWithRetriesOptions {
  segments: Segment[];
  translator: Translator;
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  context?: string | undefined;
  maxRetries?: number;
  retryMinTimeoutMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  signal?: AbortSignal;
  onRetry?: (event: TranslateBatchRetryEvent) => void;
}

interface TranslateUiBatchWithRetriesResult {
  translations: Map<string, string>;
  tokenFailures: TokenValidationIssue[];
}

async function translateUiBatchWithRetries(opts: TranslateUiBatchWithRetriesOptions): Promise<TranslateUiBatchWithRetriesResult> {
  const totalAttempts = Math.max(1, (opts.maxRetries ?? 0) + 1);
  let translations: Map<string, string> | undefined;
  let tokenFailures: TokenValidationIssue[] = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const result = await translateBatch({
        translator: opts.translator,
        segments: opts.segments,
        glossary: opts.glossary,
        sourceLocale: opts.sourceLocale,
        targetLocale: opts.targetLocale,
        // Don't double-retry: we handle retries here so the token
        // validator sees every attempt's output.
        maxRetries: 0,
        ...(opts.context !== undefined ? { context: opts.context } : {}),
        ...(opts.retryMinTimeoutMs !== undefined ? { retryMinTimeoutMs: opts.retryMinTimeoutMs } : {}),
        ...(opts.retryFactor !== undefined ? { retryFactor: opts.retryFactor } : {}),
        ...(opts.retryRandomize !== undefined ? { retryRandomize: opts.retryRandomize } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });

      // Validate token preservation across every translated segment.
      const failures: TokenValidationIssue[] = [];
      for (const segment of opts.segments) {
        const translation = result.get(segment.id);
        if (translation === undefined) continue;
        const issue = validateTokenPreservation(segment.id, segment.text, translation);
        if (issue !== null) failures.push(issue);
      }

      if (failures.length === 0) {
        return { translations: result, tokenFailures: [] };
      }

      const tokenErr = new Error(
        `[polystella] token-preservation validation failed for ${failures.length} key(s): ${failures
          .map((f) => `${f.key} (missing: [${f.missing.join(", ")}], spurious: [${f.spurious.join(", ")}])`)
          .join("; ")}`,
      );
      tokenFailures = failures;
      translations = result;

      // Last attempt → fall through to "land partial results + report".
      if (attempt < totalAttempts) {
        opts.onRetry?.({ attempt, totalAttempts, error: tokenErr });
        continue;
      }
    } catch (err) {
      // Provider / parse failure. Re-throw on the final attempt so the
      // caller sees the real error; otherwise log via onRetry and try
      // again. `translateBatch` itself does not retry (we set
      // maxRetries: 0 above), so this is the sole retry surface.
      if (attempt >= totalAttempts) throw err;
      opts.onRetry?.({ attempt, totalAttempts, error: err as Error });
    }
  }

  if (translations === undefined) {
    // Shouldn't be reachable: the loop either succeeds, returns a
    // partial result with tokenFailures, or rethrows. Defensive.
    return { translations: new Map(), tokenFailures };
  }

  return { translations, tokenFailures };
}
