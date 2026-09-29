import { traced } from './logger';
import {
  getAdapter,
  callClaudeAPI,
  type LLMAdapter,
  type ModelType
} from './llm-adapters';
import { ErrorType } from './errors';
import {
  isValidJSONString,
  validateTranslationEntry,
  sanitizeJsonResponse,
  type GuardrailMode
} from './validation-utils';
import { GUARDRAIL_SUPPORTED_LOCALES } from './guardrail';
import { callJudge } from './guardrail/judge';
import type { RetryContext } from './prompt-utils';
import { collectLLMStream } from './llm-stream';
import { withTimeout } from './utils';
import { runWorkersAi } from './workers-ai-http';

const ROUGH_TOKEN_CHAR_RATIO = 4;
type JsonCatalog = Record<string, unknown>;

// ── Public types ──────────────────────────────────────────────────────────────

export interface TranslateTextParams {
  /** Runtime env/bindings/secrets */
  env: {
    AI: Ai;
    ANTHROPIC_API_KEY: string;
  };
  /**
   * Source locale code (BCP-47, e.g. "en-US", "ja-JP"). Required —
   * caller must explicitly declare intent (mirrors the `guardrailMode`
   * convention). The API handler resolves an omitted request
   * `sourceLocale` field to "en-US" before calling this. Drives prompt
   * wording ("translate from X to Y") and the terminology-glossary gate
   * (skipped when the source isn't English).
   */
  sourceLocale: string;
  /** Target locale code (BCP-47, e.g. "fr-FR") */
  locale: string;
  /** Source text to translate (plain string or JSON string) */
  text: string;
  /** Which LLM model to use */
  model: ModelType;
  /**
   * If set, run one additional attempt with this model after the primary
   * `model` exhausts `maxAttempts` and the outcome is failure/partial_success.
   * Pass `null` (or omit) to disable. The fallback is skipped if it equals
   * the primary `model` (defensive). Caller is responsible for setting this
   * to null when the client explicitly specified a model — see
   * `api/src/index.ts` handler.
   */
  fallbackModel?: ModelType | null;
  /** Maximum retry attempts */
  maxAttempts: number;
  /** Per-attempt timeout for LLM calls (milliseconds) */
  llmTimeoutMs?: number;
  /**
   * Content guardrail mode. Required — caller must explicitly declare intent.
   * Pass `'off'` to disable. See `validation-utils.GuardrailMode`.
   */
  guardrailMode: GuardrailMode;
  /**
   * When true, Braintrust guardrail span events include the matched wordlist
   * terms. Required — caller must explicitly declare intent (usually `false`).
   */
  logGuardrailMatches: boolean;
}

/** Per-attempt record for observability */
export interface AttemptRecord {
  attempt: number;
  llmLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  streamed: boolean;
  streamChunkCount: number;
  streamFirstTokenMs: number | null;
  streamDurationMs: number;
  errors: Array<{ type: ErrorType; message: string }>;
}

export interface TranslateTextResult {
  locale: string;
  translation: JsonCatalog | string;
  attempts: AttemptRecord[];
  outcome: 'success' | 'partial_success' | 'failure';
  /**
   * The `ValidModel` that actually executed for this locale's outcome:
   * - `success` / `partial_success`: the adapter that produced output (primary or fallback)
   * - `failure`: the adapter consulted last (fallback if it ran, otherwise primary)
   *
   * This may differ from the request's primary model when runtime fallback
   * (see `fallbackModel` param) was triggered. The handler uses this to
   * surface accurate per-locale model attribution in the API response
   * `meta` field — clients should never assume the request's `model` field
   * matches what executed.
   */
  modelUsed: ModelType;
  /** Set only when outcome is 'failure' */
  error?: { type: ErrorType; message: string };
}

// ── Implementation ────────────────────────────────────────────────────────────

export async function translateText(
  params: TranslateTextParams
): Promise<TranslateTextResult> {
  const {
    env,
    sourceLocale,
    locale,
    text,
    model,
    fallbackModel = null,
    maxAttempts,
    llmTimeoutMs = 90_000,
    guardrailMode,
    logGuardrailMatches
  } = params;
  const adapter = getAdapter(model);
  const guardrailSupported = (
    GUARDRAIL_SUPPORTED_LOCALES as readonly string[]
  ).includes(locale);

  return traced(
    async (span) => {
      const localeStartTime = Date.now();
      const runClaude = false;
      const isJSON = isValidJSONString(text);
      const originalSourceCatalog: JsonCatalog | null = isJSON
        ? JSON.parse(text)
        : null;

      let pendingCatalog: JsonCatalog = { ...originalSourceCatalog };
      let successfulCatalog: JsonCatalog = {};
      let failedCatalog: JsonCatalog = {};
      let currentTextToTranslate = text;

      const attempts: AttemptRecord[] = [];
      let lastError: { type: ErrorType; message: string } | undefined;
      let promptMeta: import('./prompt-utils').PromptBuildMeta | undefined;

      /**
       * Tracks keys that have already been evaluated by the LLM judge
       * (shadow-only). Prevents re-judging previously-successful keys on
       * retry attempts — successfulCatalog accumulates across attempts,
       * but the judge should only evaluate each key once.
       */
      const judgedKeys = new Set<string>();

      /**
       * Per-key count of guardrail-DRIVEN failures observed in prior
       * attempts for this locale. Drives retry-prompt tier selection scoped
       * to the keys actually being retried in the upcoming attempt.
       *
       * Important: this counter is incremented ONLY when a key actually
       * fails validation because of the guardrail — i.e. in `enforce` mode
       * with `entryValidation.success === false && guardrail` set. Shadow-
       * mode flags and placeholder-only failures never increment this
       * counter, so a placeholder-driven retry will not accidentally pick
       * up guardrail reinforcement from an earlier unrelated flag.
       *
       * Tier selection rules (see `prompt-utils.ts :: GUARDRAIL_RETRY_REINFORCEMENT`):
       *  - Any key in the retry batch flagged at least once → tier 1
       *  - Any key in the retry batch flagged 2+ times → tier 2 stacks on top
       *  - Retry batch with no previously-flagged keys (e.g. placeholder-only
       *    retries) → no reinforcement
       */
      const guardrailFlagCountByKey = new Map<string, number>();

      /**
       * Build the retry context for the NEXT attempt's system prompt,
       * scoped to the keys actually being retried.
       *
       * Scans `pendingCatalog` (the upcoming retry batch). If any of those
       * keys has a guardrail flag count from prior attempts, uses the max
       * count among them for tier selection. Keys failing for placeholder
       * reasons only — with no prior guardrail flag — do not trigger
       * reinforcement, so a pure-placeholder retry batch gets a clean
       * prompt.
       *
       * Returns undefined on attempt 1 and when no key in the upcoming
       * batch has been flagged in this locale's history.
       */
      const deriveRetryContext = (): RetryContext | undefined => {
        if (guardrailFlagCountByKey.size === 0) return undefined;
        const batchKeys = isJSON ? Object.keys(pendingCatalog) : [];
        let maxCount = 0;
        for (const key of batchKeys) {
          const count = guardrailFlagCountByKey.get(key);
          if (count !== undefined && count > maxCount) {
            maxCount = count;
          }
        }
        if (maxCount === 0) return undefined;
        return {
          reason: 'content_guardrail',
          previousFailureCount: maxCount
        };
      };

      const logPromptContextOnce = (
        meta: import('./prompt-utils').PromptBuildMeta,
        attemptAdapter: LLMAdapter
      ) => {
        if (promptMeta) {
          return;
        }
        promptMeta = meta;
        console.log(
          `  [${locale}] Start | model=${attemptAdapter.modelId} terminology=${promptMeta.hasTerminology} guide=${promptMeta.styleGuideSource ?? 'none'} guardrail=${guardrailMode}${guardrailSupported ? '' : ' (locale_out_of_scope)'}`
        );
        span.log({
          input: { text_chars: text.length, locale, sourceLocale },
          metadata: {
            locale,
            source_locale: sourceLocale,
            model_type: model,
            model_id: attemptAdapter.modelId,
            max_attempts: maxAttempts,
            is_json: isJSON,
            has_terminology: promptMeta.hasTerminology,
            terminology_entry_count: promptMeta.terminologyEntryCount,
            style_guide_source: promptMeta.styleGuideSource,
            guardrail_mode: guardrailMode,
            guardrail_supported: guardrailSupported
          },
          tags: ['translation', 'locale-start']
        });

        // One-shot observability: when the guardrail is enabled for the
        // request but this locale is outside our supported set, record a
        // single `guardrail_skipped` event so the coverage gap is visible in
        // Braintrust without per-key log spam.
        if (guardrailMode !== 'off' && !guardrailSupported) {
          span.log({
            metadata: {
              event: 'guardrail_skipped',
              locale,
              guardrail_mode: guardrailMode,
              skip_reason: 'locale_out_of_scope'
            },
            tags: ['guardrail-skipped']
          });
        }
      };

      type AttemptOutcome =
        | { outcome: 'continue' }
        | { outcome: 'success_json'; translation: JsonCatalog }
        | { outcome: 'success_text'; translation: string };

      /**
       * Run a single translation attempt. Mutates the closure-scoped state
       * (pendingCatalog, successfulCatalog, failedCatalog,
       * currentTextToTranslate, attempts, guardrailFlagCountByKey,
       * lastError, promptMeta) and returns what the outer loop should do
       * next.
       *
       * Behavior must be identical to the inlined attempt body it
       * replaces — this is a refactor, not a behavior change. Task 5 will
       * use this closure to run a fallback attempt with a different
       * adapter without copy-pasting the per-attempt logic.
       */
      const runOneAttempt = async (
        attemptAdapter: LLMAdapter,
        attempt: number
      ): Promise<AttemptOutcome> => {
        const attemptRecord: AttemptRecord = {
          attempt,
          llmLatencyMs: 0,
          promptTokens: 0,
          completionTokens: 0,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        };
        const llmStart = Date.now();
        const pendingKeyCount = isJSON ? Object.keys(pendingCatalog).length : 1;
        const inputChars = currentTextToTranslate.length;
        const estimatedInputTokens = Math.ceil(
          inputChars / ROUGH_TOKEN_CHAR_RATIO
        );
        const retryContext = deriveRetryContext();

        span.log({
          metadata: {
            event: 'locale_attempt_start',
            locale,
            attempt,
            pending_key_count: pendingKeyCount,
            input_chars: inputChars,
            estimated_input_tokens: estimatedInputTokens,
            model_id: attemptAdapter.modelId,
            // Observability for retry-prompt escalation. Null on first
            // attempts and any attempt where no prior key was flagged.
            retry_reason: retryContext?.reason ?? null,
            retry_previous_failure_count:
              retryContext?.previousFailureCount ?? 0,
            retry_escalation_tier: retryContext
              ? retryContext.previousFailureCount >= 2
                ? 2
                : 1
              : 0
          },
          tags: ['locale-attempt-start']
        });

        try {
          // ── Call the LLM ──────────────────────────────────────────────────
          let rawResponse: string | null = null;

          if (runClaude) {
            rawResponse = await callClaudeAPI(
              env.ANTHROPIC_API_KEY,
              sourceLocale,
              locale,
              currentTextToTranslate
            );
          } else {
            const streamFirstTokenTimeoutMs = Math.min(llmTimeoutMs, 30_000);
            const streamIdleTimeoutMs = Math.min(llmTimeoutMs, 15_000);

            if (
              attemptAdapter.supportsStreaming &&
              attemptAdapter.formatStreamInput
            ) {
              const { input: streamInput, promptMeta: streamPromptMeta } =
                attemptAdapter.formatStreamInput(
                  sourceLocale,
                  locale,
                  currentTextToTranslate,
                  retryContext
                );

              logPromptContextOnce(streamPromptMeta, attemptAdapter);

              try {
                const llmCallStartTime = Date.now();
                span.log({
                  metadata: {
                    event: 'llm_call_start',
                    locale,
                    attempt,
                    model_id: attemptAdapter.modelId,
                    llm_timeout_ms: llmTimeoutMs,
                    pending_key_count: pendingKeyCount,
                    estimated_input_tokens: estimatedInputTokens,
                    streamed: true
                  },
                  tags: ['llm-call-start']
                });

                const streamResult = await collectLLMStream({
                  runPromise: runWorkersAi(
                    env,
                    attemptAdapter.modelId,
                    streamInput
                  ),
                  totalTimeoutMs: llmTimeoutMs,
                  firstTokenTimeoutMs: streamFirstTokenTimeoutMs,
                  idleTimeoutMs: streamIdleTimeoutMs,
                  locale
                });

                rawResponse = streamResult.text;
                attemptRecord.streamed = true;
                attemptRecord.streamChunkCount = streamResult.chunkCount;
                attemptRecord.streamFirstTokenMs = streamResult.firstTokenMs;
                attemptRecord.streamDurationMs = streamResult.totalStreamMs;
                attemptRecord.promptTokens = streamResult.usage.promptTokens;
                attemptRecord.completionTokens =
                  streamResult.usage.completionTokens;

                logLLMOutput({
                  locale,
                  attempt,
                  model,
                  modelId: attemptAdapter.modelId,
                  streamed: true,
                  output: rawResponse,
                  streamChunkCount: streamResult.chunkCount,
                  streamFirstTokenMs: streamResult.firstTokenMs,
                  streamDurationMs: streamResult.totalStreamMs
                });

                console.log(
                  `  [${locale}] Attempt ${attempt} | streamed=true first_token_ms=${streamResult.firstTokenMs ?? -1} chunks=${streamResult.chunkCount} duration_ms=${streamResult.totalStreamMs}`
                );
                span.log({
                  metadata: {
                    event: 'llm_call_end',
                    locale,
                    attempt,
                    model_type: model,
                    model_id: attemptAdapter.modelId,
                    llm_latency_ms: Date.now() - llmCallStartTime,
                    prompt_tokens: streamResult.usage.promptTokens,
                    completion_tokens: streamResult.usage.completionTokens,
                    streamed: true,
                    stream_chunk_count: streamResult.chunkCount,
                    stream_first_token_ms: streamResult.firstTokenMs,
                    stream_duration_ms: streamResult.totalStreamMs
                  },
                  tags: ['llm-call-end']
                });
              } catch (streamError) {
                const streamErrorMessage =
                  streamError instanceof Error
                    ? streamError.message
                    : 'Unknown stream error';
                console.warn(
                  `  [${locale}] Attempt ${attempt} | stream failed: ${streamErrorMessage}`
                );
                span.log({
                  error: {
                    type: ErrorType.LLM_CALL_FAILED,
                    message: `stream_failed: ${streamErrorMessage}`
                  },
                  metadata: {
                    event: 'llm_call_error',
                    locale,
                    attempt,
                    model_type: model,
                    model_id: attemptAdapter.modelId
                  },
                  tags: ['llm-call-error', 'stream-failure']
                });

                throw streamError;
              }
            } else {
              const { input, promptMeta: meta } = attemptAdapter.formatInput(
                sourceLocale,
                locale,
                currentTextToTranslate,
                retryContext
              );

              logPromptContextOnce(meta, attemptAdapter);

              const llmCallStartTime = Date.now();
              span.log({
                metadata: {
                  event: 'llm_call_start',
                  locale,
                  attempt,
                  model_id: attemptAdapter.modelId,
                  llm_timeout_ms: llmTimeoutMs,
                  pending_key_count: pendingKeyCount,
                  estimated_input_tokens: estimatedInputTokens,
                  streamed: false
                },
                tags: ['llm-call-start']
              });

              const response: unknown = await withTimeout(
                runWorkersAi(env, attemptAdapter.modelId, input),
                llmTimeoutMs,
                `LLM call timed out after ${llmTimeoutMs}ms for locale [${locale}]`
              );
              rawResponse = attemptAdapter.extractResponse(response);

              const usage = attemptAdapter.extractUsage(response);
              attemptRecord.promptTokens = usage.promptTokens;
              attemptRecord.completionTokens = usage.completionTokens;

              logLLMOutput({
                locale,
                attempt,
                model,
                modelId: attemptAdapter.modelId,
                streamed: false,
                output: rawResponse
              });

              span.log({
                metadata: {
                  event: 'llm_call_end',
                  locale,
                  attempt,
                  model_type: model,
                  model_id: attemptAdapter.modelId,
                  llm_latency_ms: Date.now() - llmCallStartTime,
                  prompt_tokens: usage.promptTokens,
                  completion_tokens: usage.completionTokens,
                  response_chars:
                    typeof rawResponse === 'string' ? rawResponse.length : 0,
                  streamed: false
                },
                tags: ['llm-call-end']
              });
            }
          }

          attemptRecord.llmLatencyMs = Date.now() - llmStart;

          // ── Sanitize response ─────────────────────────────────────────────
          if (typeof rawResponse === 'string') {
            rawResponse = sanitizeJsonResponse(rawResponse);
          }

          // ── Empty response check ──────────────────────────────────────────
          if (!rawResponse) {
            const err = {
              type: ErrorType.LLM_EMPTY_RESPONSE,
              message: `Empty response from LLM for locale [${locale}]`
            };
            attemptRecord.errors.push(err);
            lastError = err;
            attempts.push(attemptRecord);
            return { outcome: 'continue' };
          }

          // ── Parse response ────────────────────────────────────────────────
          let currentLLMTranslationCatalog: unknown;
          if (typeof rawResponse === 'string') {
            try {
              currentLLMTranslationCatalog = JSON.parse(rawResponse);
            } catch {
              currentLLMTranslationCatalog = rawResponse;
            }
          } else {
            currentLLMTranslationCatalog = rawResponse;
          }

          // ── JSON validation path ──────────────────────────────────────────
          if (isJSON) {
            if (
              typeof currentLLMTranslationCatalog !== 'object' ||
              currentLLMTranslationCatalog === null
            ) {
              const err = {
                type: ErrorType.LLM_MALFORMED_JSON,
                message: `Malformed JSON response from LLM for locale [${locale}]`
              };
              attemptRecord.errors.push(err);
              lastError = err;
              attempts.push(attemptRecord);
              return { outcome: 'continue' };
            }
            const llmTranslationCatalog =
              currentLLMTranslationCatalog as JsonCatalog;

            for (const key of Object.keys(pendingCatalog).sort()) {
              const originalSourceValue = originalSourceCatalog?.[key];
              const llmTranslationValue = llmTranslationCatalog[key];

              if (!originalSourceValue) {
                continue;
              }

              // Missing key
              if (!llmTranslationValue) {
                failedCatalog[key] = originalSourceValue;
                attemptRecord.errors.push({
                  type: ErrorType.MISSING_TRANSLATION_KEY,
                  message: `Missing translation key - ${key} for locale [${locale}]`
                });
                continue;
              }

              // Placeholder + (optionally) content-guardrail validation.
              const entryValidation = validateTranslationEntry(
                originalSourceValue,
                llmTranslationValue,
                key,
                locale,
                guardrailMode
              );

              // Observability: emit a Braintrust span event for any
              // guardrail flag, in either `shadow` or `enforce` mode.
              //
              // IMPORTANT: in `shadow` mode the flag is informational only
              // — it must NOT surface as a Braintrust span `error:` because
              // the translation didn't actually fail. Only `enforce` mode
              // attaches an `error:` field; `shadow` mode logs just
              // `metadata:` + tags so the event is observable without
              // polluting error-rate dashboards.
              //
              // The per-key flag count that drives retry-prompt escalation
              // is incremented ONLY when the key actually fails validation
              // (gated on `!entryValidation.success` below). In shadow
              // mode, flagged keys still succeed and are not retried, so
              // their counter stays at 0 — which is what we want:
              // shadow-mode flags should never influence future prompts.
              if (entryValidation.guardrail) {
                const gd = entryValidation.guardrail;

                // key_flag_count in the span event reflects the count we
                // WILL have after this attempt's accounting below, so we
                // can report it accurately in the span log.
                const priorCount = guardrailFlagCountByKey.get(key) ?? 0;
                const willIncrement =
                  !entryValidation.success && !!entryValidation.guardrail;
                const reportedCount = willIncrement
                  ? priorCount + 1
                  : priorCount;

                const flagMetadata = {
                  event: 'guardrail_flagged',
                  locale,
                  attempt,
                  key: gd.subKey,
                  guardrail_mode: guardrailMode,
                  match_count: gd.matches.length,
                  wordlist_applied: gd.wordlistApplied,
                  // Running per-key flag count across this locale's
                  // attempts. Only increments for keys that actually fail
                  // validation. Useful for spotting persistently-flagged
                  // keys that survive retry escalation.
                  key_flag_count: reportedCount,
                  ...(logGuardrailMatches && {
                    flagged_matches: gd.matches
                  })
                };

                if (guardrailMode === 'enforce') {
                  span.log({
                    error: {
                      type: ErrorType.CONTENT_GUARDRAIL_FLAGGED,
                      message: `content_guardrail_flagged locale=${locale} key=${gd.subKey}`
                    },
                    metadata: flagMetadata,
                    tags: ['guardrail-flagged']
                  });
                } else {
                  span.log({
                    metadata: flagMetadata,
                    tags: ['guardrail-flagged']
                  });
                }
              }

              if (!entryValidation.success) {
                failedCatalog[key] = originalSourceValue;
                const errorType = entryValidation.guardrail
                  ? ErrorType.CONTENT_GUARDRAIL_FLAGGED
                  : ErrorType.PLACEHOLDER_MISMATCH;

                // Increment the per-key guardrail flag counter ONLY when
                // the guardrail actually caused the retry. Skipping this
                // on `shadow` (where !success can't fire from guardrail
                // alone) and on placeholder-only failures prevents
                // spurious retry-prompt escalation for keys whose retries
                // were never driven by a guardrail flag.
                if (entryValidation.guardrail) {
                  const priorCount = guardrailFlagCountByKey.get(key) ?? 0;
                  guardrailFlagCountByKey.set(key, priorCount + 1);
                }

                attemptRecord.errors.push({
                  type: errorType,
                  message: entryValidation.errors.join('; ')
                });
                continue;
              }

              // Shadow-mode flags (where `success === true`) are NOT pushed
              // to `attemptRecord.errors` — doing so would cause
              // logSpanResult to stamp a top-level `error:` on the final
              // locale span via its `allErrors` aggregation, making a
              // successful translation look like a failure to Braintrust
              // error dashboards. The flag is already captured via the
              // `span.log` above; no second place is needed.

              successfulCatalog[key] = llmTranslationValue;
            }

            // ── LLM judge (shadow-only) ───────────────────────────────────
            // After per-key placeholder + wordlist validation, run a
            // DIFFERENT LLM as a judge to detect bad words in translations
            // that passed Phase 1. Results are logged to Braintrust only —
            // the judge never blocks, retries, or modifies
            // successfulCatalog/failedCatalog. Judge failures are logged.
            //
            // Gated on guardrailMode: when 'off', no guardrail activity
            // runs — consistent with the Phase 1 wordlist convention.
            // The 10s timeout in callJudge bounds the worst case.
            const newlySuccessfulKeys = Object.keys(successfulCatalog).filter(
              (k) => !judgedKeys.has(k)
            );
            if (
              newlySuccessfulKeys.length > 0 &&
              originalSourceCatalog &&
              guardrailMode !== 'off'
            ) {
              try {
                // Skip entries exceeding the character limit
                const JUDGE_MAX_ENTRY_CHARS = 1000;
                const skippedKeys: string[] = [];
                const judgeEntries: {
                  key: string;
                  source: string;
                  translation: string;
                }[] = [];

                for (const k of newlySuccessfulKeys) {
                  const sourceValue = originalSourceCatalog[k];
                  const translationValue = successfulCatalog[k];
                  const src =
                    typeof sourceValue === 'string'
                      ? sourceValue
                      : (JSON.stringify(sourceValue) ?? '');
                  const trl =
                    typeof translationValue === 'string'
                      ? translationValue
                      : (JSON.stringify(translationValue) ?? '');

                  if (trl.length > JUDGE_MAX_ENTRY_CHARS) {
                    skippedKeys.push(k);
                  } else {
                    judgeEntries.push({
                      key: k,
                      source: src,
                      translation: trl
                    });
                  }
                }

                if (skippedKeys.length > 0) {
                  span.log({
                    metadata: {
                      event: 'judge_skipped_too_long',
                      locale,
                      attempt,
                      skipped_keys: skippedKeys,
                      skipped_count: skippedKeys.length,
                      max_chars: JUDGE_MAX_ENTRY_CHARS
                    },
                    tags: ['judge-skipped']
                  });
                  // Mark skipped keys as judged so they are not
                  // re-evaluated on subsequent retry attempts.
                  for (const k of skippedKeys) {
                    judgedKeys.add(k);
                  }
                }

                if (judgeEntries.length > 0) {
                  const { result: judgeResult, meta: judgeMeta } =
                    await callJudge(env, judgeEntries, locale, model);

                  // Mark judged keys so they are not re-evaluated on
                  // subsequent retry attempts.
                  for (const { key: k } of judgeEntries) {
                    judgedKeys.add(k);
                  }

                  if (judgeResult.ok) {
                    const redactedFlaggedKeys = judgeMeta.flaggedKeys.map(
                      (f) => ({
                        key: f.key,
                        ...(logGuardrailMatches && {
                          term: f.term,
                          reasoning: f.reasoning
                        })
                      })
                    );

                    span.log({
                      metadata: {
                        event: 'judge_shadow',
                        locale,
                        attempt,
                        judge_model: judgeMeta.judgeModel,
                        translator_model: judgeMeta.translatorModel,
                        keys_evaluated: judgeMeta.keysEvaluated,
                        keys_flagged: judgeMeta.keysFlagged,
                        flagged_keys: redactedFlaggedKeys,
                        latency_ms: judgeMeta.latencyMs
                      },
                      tags: ['judge-shadow']
                    });
                  } else {
                    span.log({
                      metadata: {
                        event: 'judge_shadow_error',
                        locale,
                        attempt,
                        judge_model: judgeMeta.judgeModel,
                        error: judgeMeta.error ?? judgeResult.error,
                        latency_ms: judgeMeta.latencyMs
                      },
                      tags: ['judge-shadow-error']
                    });
                  }
                }
              } catch (judgeErr) {
                // Judge must never prevent translation from completing.
                span.log({
                  metadata: {
                    event: 'judge_shadow_unexpected_error',
                    locale,
                    attempt,
                    error:
                      judgeErr instanceof Error
                        ? judgeErr.message
                        : String(judgeErr)
                  },
                  tags: ['judge-shadow-error']
                });
              }
            }

            // Retry failed keys on next attempt
            if (Object.keys(failedCatalog).length > 0) {
              const failedKeys = Object.keys(failedCatalog);
              console.log(
                `  [${locale}] Attempt ${attempt} | ${failedKeys.length} keys failed, retrying: ${failedKeys.join(', ')}`
              );
              currentTextToTranslate = JSON.stringify(failedCatalog);
              pendingCatalog = { ...failedCatalog };
              failedCatalog = {};
              attempts.push(attemptRecord);
              return { outcome: 'continue' };
            }

            // All keys succeeded
            attempts.push(attemptRecord);
            return {
              outcome: 'success_json',
              translation: { ...successfulCatalog }
            };
          } else {
            // ── Plain text path ───────────────────────────────────────────
            // Known gap: content guardrail is NOT invoked on plain-text
            // input. Guardrail only runs through validateTranslationEntry,
            // which is scoped to the JSON per-key loop above.
            attempts.push(attemptRecord);
            return {
              outcome: 'success_text',
              translation: currentLLMTranslationCatalog as unknown as string
            };
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          const err = { type: ErrorType.LLM_CALL_FAILED, message };
          attemptRecord.errors.push(err);
          lastError = err;
          attemptRecord.llmLatencyMs = Date.now() - llmStart;
          attempts.push(attemptRecord);
          span.log({
            error: {
              type: ErrorType.LLM_CALL_FAILED,
              message
            },
            metadata: {
              event: 'locale_attempt_error',
              locale,
              attempt,
              model_id: attemptAdapter.modelId,
              llm_latency_ms: attemptRecord.llmLatencyMs
            },
            tags: ['locale-attempt-error']
          });
          return { outcome: 'continue' };
        }
      };

      let finalTranslation: JsonCatalog | string | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await runOneAttempt(adapter, attempt);
        if (result.outcome === 'success_json') {
          finalTranslation = result.translation;
          break;
        }
        if (result.outcome === 'success_text') {
          finalTranslation = result.translation;
          break;
        }
        // 'continue' → next iteration
      }

      if (finalTranslation !== null) {
        const successResult: TranslateTextResult = {
          locale,
          translation: finalTranslation,
          attempts,
          outcome: 'success',
          modelUsed: model
        };
        logSpanResult(span, successResult, adapter, localeStartTime, {
          used: false,
          fallbackAdapter: null
        });
        return successResult;
      }

      // Primary loop exhausted without success — proceed to failure handling below.

      // Snapshot whether the primary model produced any successful keys
      // before fallback runs. Drives `modelUsed` attribution for
      // partial_success outcomes: if primary contributed at least one key,
      // we attribute the locale to primary even when fallback completed
      // additional keys. The fallback's contribution remains observable in
      // Braintrust (see `fallback_used`/`fallback_model_id` span fields).
      const primaryContributedKeyCount = Object.keys(successfulCatalog).length;

      // ── Fallback attempt ──────────────────────────────────────────────────
      // Triggers when the primary model exhausted maxAttempts without a
      // success result, and the caller passed a non-null fallbackModel that
      // differs from the primary model.
      const shouldRunFallback =
        fallbackModel !== null && fallbackModel !== model;
      const fallbackAdapter: LLMAdapter | null = shouldRunFallback
        ? getAdapter(fallbackModel)
        : null;

      if (shouldRunFallback && fallbackAdapter) {
        span.log({
          metadata: {
            event: 'fallback_attempt_start',
            locale,
            primary_model_id: adapter.modelId,
            fallback_model_id: fallbackAdapter.modelId,
            primary_attempts_used: attempts.length,
            pending_key_count: isJSON ? Object.keys(pendingCatalog).length : 1
          },
          tags: ['fallback-attempt-start']
        });
        console.log(
          `  [${locale}] Fallback | primary=${adapter.modelId} fallback=${fallbackAdapter.modelId} after ${attempts.length} primary attempts`
        );

        const fallbackResult = await runOneAttempt(
          fallbackAdapter,
          attempts.length + 1
        );

        if (fallbackResult.outcome === 'success_json') {
          const successResult: TranslateTextResult = {
            locale,
            translation: fallbackResult.translation,
            attempts,
            outcome: 'success',
            modelUsed: fallbackModel
          };
          logSpanResult(span, successResult, fallbackAdapter, localeStartTime, {
            used: true,
            fallbackAdapter
          });
          return successResult;
        }
        if (fallbackResult.outcome === 'success_text') {
          const successResult: TranslateTextResult = {
            locale,
            translation: fallbackResult.translation,
            attempts,
            outcome: 'success',
            modelUsed: fallbackModel
          };
          logSpanResult(span, successResult, fallbackAdapter, localeStartTime, {
            used: true,
            fallbackAdapter
          });
          return successResult;
        }
        // 'continue' → fall through to the existing failure/partial_success handler
      }

      // All attempts exhausted
      console.error(
        `  [${locale}] Failed | exhausted ${attempts.length} attempts, last error: ${lastError?.message}`
      );
      // Attribute `modelUsed` for the response `meta` field.
      //
      // Reasoning:
      // - failure (no keys translated): attribute to the LAST model
      //   consulted — fallback if it ran, else primary. Honors the
      //   principle that an outcome is attributed to the model that
      //   actually attempted it.
      // - partial_success: attribute to the FIRST contributor — primary if
      //   it produced any keys before fallback ran, otherwise fallback.
      //   The primary is what the client asked for, so when it contributes
      //   anything it deserves the headline. Per-key/multi-model truth
      //   lives in Braintrust traces (see `fallback_used`,
      //   `fallback_model_id` on the locale span).
      //
      // Invariant: if `partial_success` and `primaryContributedKeyCount === 0`,
      // the only way `successfulCatalog` got populated is via the fallback
      // attempt — so `fallbackModel` is guaranteed non-null in that branch.
      const totalSuccessfulKeys = Object.keys(successfulCatalog).length;
      const isPartialSuccess = totalSuccessfulKeys > 0;
      let modelUsed: ModelType;
      if (isPartialSuccess) {
        if (primaryContributedKeyCount > 0) {
          modelUsed = model;
        } else if (fallbackModel !== null) {
          modelUsed = fallbackModel;
        } else {
          // Should be unreachable per the invariant above. Defensive fallback
          // to primary so the type narrows and we never emit `undefined`.
          modelUsed = model;
        }
      } else {
        // failure: last consulted model
        modelUsed =
          shouldRunFallback && fallbackModel !== null ? fallbackModel : model;
      }
      const result: TranslateTextResult = {
        locale,
        translation: isPartialSuccess ? successfulCatalog : '',
        attempts,
        outcome: isPartialSuccess ? 'partial_success' : 'failure',
        modelUsed,
        error: {
          type: ErrorType.RETRY_EXHAUSTED,
          message: `Failed to get valid translation for ${locale} after ${attempts.length} attempts: ${lastError?.message}`
        }
      };
      logSpanResult(span, result, adapter, localeStartTime, {
        used: shouldRunFallback,
        fallbackAdapter
      });
      return result;
    },
    { name: `translate-${locale}`, type: 'llm' }
  );
}

function logLLMOutput(params: {
  locale: string;
  attempt: number;
  model: ModelType;
  modelId: keyof AiModels;
  streamed: boolean;
  output: string | null;
  streamChunkCount?: number;
  streamFirstTokenMs?: number | null;
  streamDurationMs?: number;
}) {
  const responseChars = params.output?.length ?? 0;

  if (params.streamed) {
    console.log(
      `  [${params.locale}] Attempt ${params.attempt} | llm_output streamed=true model=${params.model} model_id=${params.modelId} response_chars=${responseChars} chunks=${params.streamChunkCount ?? 0} first_token_ms=${params.streamFirstTokenMs ?? -1} duration_ms=${params.streamDurationMs ?? 0}`
    );
    return;
  }

  console.log(
    `  [${params.locale}] Attempt ${params.attempt} | llm_output streamed=false model=${params.model} model_id=${params.modelId} response_chars=${responseChars}`
  );
}

/** Logs the final output, metrics, and errors to the Braintrust span */
function logSpanResult(
  span: { log: (event: Record<string, unknown>) => void },
  result: TranslateTextResult,
  adapter: LLMAdapter,
  startTime: number,
  fallbackInfo: {
    used: boolean;
    fallbackAdapter: LLMAdapter | null;
  } = { used: false, fallbackAdapter: null }
) {
  const durationMs = Date.now() - startTime;

  // Aggregate metrics across all attempts
  const totalLlmLatencyMs = result.attempts.reduce(
    (sum, a) => sum + a.llmLatencyMs,
    0
  );
  const totalPromptTokens = result.attempts.reduce(
    (sum, a) => sum + a.promptTokens,
    0
  );
  const totalCompletionTokens = result.attempts.reduce(
    (sum, a) => sum + a.completionTokens,
    0
  );
  const streamedAttempts = result.attempts.filter((a) => a.streamed);
  const streamChunkCount = streamedAttempts.reduce(
    (sum, a) => sum + a.streamChunkCount,
    0
  );
  const streamDurationMs = streamedAttempts.reduce(
    (sum, a) => sum + a.streamDurationMs,
    0
  );
  const streamFirstTokenMsValues = streamedAttempts
    .map((a) => a.streamFirstTokenMs)
    .filter((value): value is number => value !== null);
  const allErrors = result.attempts.flatMap((a) => a.errors);

  span.log({
    output: {
      outcome: result.outcome,
      translation_chars: JSON.stringify(result.translation).length
    },
    metrics: {
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      tokens: totalPromptTokens + totalCompletionTokens
    },
    metadata: {
      model_id: adapter.modelId,
      locale: result.locale,
      outcome: result.outcome,
      attempt_count: result.attempts.length,
      duration_ms: durationMs,
      llm_duration_ms: totalLlmLatencyMs,
      streamed_attempt_count: streamedAttempts.length,
      stream_chunk_count_total: streamChunkCount,
      stream_duration_ms_total: streamDurationMs,
      stream_first_token_ms_min:
        streamFirstTokenMsValues.length > 0
          ? Math.min(...streamFirstTokenMsValues)
          : null,
      fallback_used: fallbackInfo.used,
      fallback_model_id: fallbackInfo.fallbackAdapter?.modelId ?? null
    },
    ...(allErrors.length > 0 && {
      error: {
        type: result.error?.type ?? allErrors[0].type,
        message: result.error?.message ?? allErrors[0].message,
        all_errors: allErrors
      }
    }),
    ...(result.outcome === 'success' && {
      tags: ['translation-success']
    }),
    ...(result.outcome === 'partial_success' && {
      tags: ['translation-partial']
    }),
    ...(result.outcome === 'failure' && {
      tags: ['translation-failure']
    })
  });
}
