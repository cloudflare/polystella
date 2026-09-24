import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { initBraintrust, traced, flushBraintrust } from './logger';
import { ValidModel, type ModelType } from './llm-adapters';
import { VALID_LOCALES } from './locales';
import { ErrorType } from './errors';
import {
  validateTokenCount,
  isValidJSONString,
  GUARDRAIL_MODES,
  type GuardrailMode
} from './validation-utils';
import { translateText, type TranslateTextResult } from './translate-text';
import { withTimeout, TimeoutError } from './utils';

interface Env {
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  BRAINTRUST_API_KEY: string;
  BRAINTRUST_API_URL: string;
  BRAINTRUST_PROJECT_NAME: string;
  BRAINTRUST_CF_ACCESS_CLIENT_ID: string;
  BRAINTRUST_CF_ACCESS_CLIENT_SECRET: string;
  GUARDRAIL_MODE?: string;
  BRAINTRUST_LOG_GUARDRAIL_MATCHES?: string;
}

function isGuardrailMode(value: string): value is GuardrailMode {
  return (GUARDRAIL_MODES as readonly string[]).includes(value);
}

function resolveGuardrailMode(
  raw: string | undefined,
  requestId: string
): GuardrailMode {
  if (!raw) return 'off';
  if (isGuardrailMode(raw)) return raw;
  console.warn(
    JSON.stringify({
      event: 'guardrail_mode_invalid',
      request_id: requestId,
      raw,
      allowed: GUARDRAIL_MODES,
      fallback: 'off'
    })
  );
  return 'off';
}

type Variables = {
  requestId: string;
};

const MODEL = ValidModel.kimi2_5;
/**
 * Fallback LLM used ONLY when the client did not specify a model and the
 * primary `MODEL` has exhausted all retry attempts for a given locale.
 * Set to `null` to disable runtime fallback entirely. See
 * docs/superpowers/specs/2026-04-27-llm-runtime-fallback-design.md
 */
const FALLBACK_MODEL: ValidModel | null = ValidModel.qwen;
const MAX_ATTEMPTS = process.env['NODE_ENV'] === 'development' ? 1 : 3;
const MAX_TOKENS_TO_TRANSLATE = 5000;
const REQUEST_TIMEOUT_MS = 16 * 60 * 1000;
const LLM_TIMEOUT_MS = 10 * 60 * 1000;
const BACKGROUND_SETTLE_TIMEOUT_MS = LLM_TIMEOUT_MS;

const app = new Hono<{ Bindings: Env; Variables: Variables }>().basePath(
  '/api'
);

/**
 * Default source locale resolved when the client omits `sourceLocale`.
 * Backward-compatible: every existing caller continues to translate from
 * English with no behavior change. See UI-8255.
 */
const DEFAULT_SOURCE_LOCALE = 'en-US' as const;

/**
 * Type guard for `VALID_LOCALES.includes(...)` checks.
 *
 * Required because `ReadonlyArray<T>.includes(x: T)` rejects arbitrary
 * `string` arguments at compile time. Using a guard instead of `as any`
 * keeps RFC-009 ("Code MUST NOT use `any`") happy while still narrowing
 * the value to the literal locale-code union for downstream use.
 */
function isValidLocale(value: string): value is (typeof VALID_LOCALES)[number] {
  return (VALID_LOCALES as readonly string[]).includes(value);
}

// Zod schema for translation request
const translationSchema = z
  .object({
    text: z.string().min(1, 'Text cannot be empty'),
    targetLocale: z
      .string()
      .min(1, 'At least one locale code is required')
      .refine(
        (value) => {
          const locales = value
            .split(',')
            .map((l) => l?.trim())
            .filter((l) => l.length > 0);
          return locales.length > 0 && locales.every(isValidLocale);
        },
        {
          message: `Invalid locale code(s). Valid locales are: ${VALID_LOCALES.join(
            ', '
          )}`
        }
      ),
    /**
     * Optional BCP-47 source locale code (e.g. "ja-JP", "en-US"). When
     * omitted, resolved server-side to `en-US`. Single value only —
     * multi-source translation is not supported. Validated against the
     * same allowlist as `targetLocale` for symmetry.
     */
    sourceLocale: z
      .string()
      .min(1, 'sourceLocale cannot be empty')
      .refine(isValidLocale, {
        message: `Invalid sourceLocale. Valid locales are: ${VALID_LOCALES.join(
          ', '
        )}`
      })
      .optional(),
    model: z.nativeEnum(ValidModel).optional()
  })
  .superRefine((data, ctx) => {
    // Cross-field check: sourceLocale must not appear in targetLocale list.
    // A request like {sourceLocale: "fr-FR", targetLocale: "fr-FR,de-DE"}
    // would translate French into French — meaningless and wastes an LLM
    // call. We surface a 400 here so the UI doesn't have to be the only
    // line of defense.
    //
    // Apply DEFAULT_SOURCE_LOCALE here too: if the client sends
    // {targetLocale: "en-US"} without sourceLocale, the handler resolves
    // it to "en-US", which would make source==target and waste an LLM
    // call. The validation must mirror what the handler will do.
    const effectiveSource = data.sourceLocale ?? DEFAULT_SOURCE_LOCALE;
    const targets = data.targetLocale
      .split(',')
      .map((l) => l?.trim())
      .filter((l) => l.length > 0);
    if (targets.includes(effectiveSource)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceLocale'],
        message: `sourceLocale (${effectiveSource}) cannot match a targetLocale`
      });
    }
    if (new Set(targets).size !== targets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetLocale'],
        message: 'Duplicate target locales are not allowed'
      });
    }
  });

// Assign a unique request ID and initialize Braintrust on every request
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  initBraintrust(c.env);
  await next();
  c.header('X-Request-Id', c.get('requestId'));
});

// Enable CORS for all routes
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['Content-Type']
  })
);

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    message: 'Translation API is running',
    version: '1.0.0'
  });
});

// Translation endpoint
app.post('/translate', zValidator('json', translationSchema), async (c) => {
  const startTime = Date.now();
  const requestId = c.get('requestId');
  const requestContext = getRawRequestContext(c.req);
  let localeTranslations: Array<Promise<TranslateTextResult>> = [];

  const guardrailMode = resolveGuardrailMode(c.env.GUARDRAIL_MODE, requestId);
  const logGuardrailMatches = c.env.BRAINTRUST_LOG_GUARDRAIL_MATCHES === 'true';

  const response = await traced(
    async (span) => {
      try {
        const body = c.req.valid('json');
        const inputText = body.text?.trim();
        const clientProvidedModel = body.model !== undefined;
        const primaryModel = body.model ?? MODEL;
        const fallbackModel: ValidModel | null =
          clientProvidedModel ||
          FALLBACK_MODEL === null ||
          FALLBACK_MODEL === primaryModel
            ? null
            : FALLBACK_MODEL;
        // Resolve sourceLocale once at the boundary so every downstream
        // call site sees a non-null string (mirrors the `guardrailMode`
        // pattern). The schema accepts an absent value; the API contract
        // says omitted == "en-US".
        const sourceLocale = body.sourceLocale ?? DEFAULT_SOURCE_LOCALE;
        const isJSON = isValidJSONString(inputText);
        const keyCount = isJSON ? Object.keys(JSON.parse(inputText)).length : 1;

        // Validate token count
        const tokenValidation = validateTokenCount(
          inputText,
          MAX_TOKENS_TO_TRANSLATE
        );

        // The structured `span.log({ metadata: { source_locale, ... } })`
        // below is the authoritative observability record (RFC-012 SHOULD:
        // logs SHOULD be structured JSON). Keep this human-readable
        // dev-console line free of new fields — add structured metadata
        // to span.log instead.
        console.log(
          `[${requestId}] POST /translate | model=${primaryModel} locales=${body.targetLocale} json=${isJSON} tokens=${tokenValidation.tokenCount}`
        );

        span.log({
          metadata: {
            event: 'request_start',
            request_id: requestId,
            token_count: tokenValidation.tokenCount,
            key_count: keyCount,
            model_type: primaryModel,
            source_locale: sourceLocale,
            request_timeout_ms: REQUEST_TIMEOUT_MS,
            llm_timeout_ms: LLM_TIMEOUT_MS,
            max_attempts: MAX_ATTEMPTS,
            guardrail_mode: guardrailMode,
            client_provided_model: clientProvidedModel,
            fallback_eligible: fallbackModel !== null,
            fallback_model: fallbackModel,
            ...requestContext
          },
          tags: ['translation', 'request-start']
        });

        if (!tokenValidation.success) {
          span.log({
            input: {
              text_chars: inputText.length,
              locales: body.targetLocale,
              model: primaryModel
            },
            output: null,
            error: {
              type: ErrorType.TOKEN_LIMIT_EXCEEDED,
              message: `Token count ${tokenValidation.tokenCount} exceeds limit of ${MAX_TOKENS_TO_TRANSLATE}`
            },
            metadata: {
              request_id: requestId,
              token_count: tokenValidation.tokenCount,
              ...requestContext
            },
            tags: ['translation', 'token-limit-exceeded']
          });
          return c.json(
            {
              error: 'Token limit exceeded',
              details: `Input text contains ${tokenValidation.tokenCount} tokens, which exceeds the maximum limit of ${MAX_TOKENS_TO_TRANSLATE} tokens`
            },
            400
          );
        }

        // Parse comma-separated locale codes
        const locales = body.targetLocale
          .split(',')
          .map((locale: string) => locale?.trim())
          .filter((locale: string) => locale.length > 0);

        // Log root span input and metadata
        span.log({
          input: {
            text_chars: inputText.length,
            locales,
            sourceLocale,
            model: primaryModel
          },
          metadata: {
            request_id: requestId,
            token_count: tokenValidation.tokenCount,
            is_json: isJSON,
            key_count: keyCount,
            locale_count: locales.length,
            model_type: primaryModel,
            source_locale: sourceLocale,
            client_provided_model: clientProvidedModel,
            fallback_eligible: fallbackModel !== null,
            fallback_model: fallbackModel,
            ...requestContext
          },
          tags: ['translation']
        });

        // Translate all locales in parallel
        localeTranslations = locales.map((locale) =>
          translateText({
            env: c.env,
            sourceLocale,
            locale,
            text: inputText,
            model: primaryModel,
            fallbackModel,
            maxAttempts: MAX_ATTEMPTS,
            llmTimeoutMs: LLM_TIMEOUT_MS,
            guardrailMode,
            logGuardrailMatches
          })
        );

        const results = await withTimeout(
          Promise.all(localeTranslations),
          REQUEST_TIMEOUT_MS,
          `Request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          () => {
            span.log({
              error: {
                type: 'request_timeout',
                message: `Request timeout timer fired after ${REQUEST_TIMEOUT_MS}ms`
              },
              metadata: {
                event: 'request_timeout_fired',
                request_id: requestId,
                total_duration_ms: Date.now() - startTime,
                request_timeout_ms: REQUEST_TIMEOUT_MS,
                ...requestContext
              },
              tags: ['request-timeout']
            });
          }
        );

        // Build the final response object keyed by locale
        const translations: Record<string, string | Record<string, string>> =
          {};
        // Per-locale execution metadata. Mirrors `translations` for success
        // and partial_success; also populated for `failure` since by then
        // an adapter was selected and consulted (see translate-text.ts:
        // `modelUsed` doc). Pre-LLM failures (token limit, schema) return a
        // different response shape and never reach this loop, so the
        // principle "model attribution only when an LLM was consulted"
        // holds at the response-shape boundary.
        //
        // Type note: `ModelType` is the union `keyof typeof adapters`,
        // which has the same five string values as `ValidModel`. We use
        // `ModelType` here so `result.modelUsed` (also `ModelType`) flows
        // through without an unsafe `as` cast (RFC-009).
        const meta: Record<string, { model: ModelType }> = {};
        const errors: Array<{ locale: string; error: string }> = [];
        const partialLocales: Array<{ locale: string; error: string }> = [];
        let totalRetries = 0;
        let successfulLocales = 0;

        for (const result of results) {
          totalRetries += result.attempts.length - 1;
          // Every per-locale outcome reports `modelUsed` (see
          // TranslateTextResult). Surface it for all three outcomes so
          // consumers can attribute success, partial output, and failures
          // to the adapter that actually ran.
          meta[result.locale] = { model: result.modelUsed };
          if (result.outcome === 'failure') {
            errors.push({
              locale: result.locale,
              error: result.error?.message ?? 'Unknown error'
            });
          } else if (result.outcome === 'partial_success') {
            successfulLocales++;
            translations[result.locale] = result.translation as
              string | Record<string, string>;
            partialLocales.push({
              locale: result.locale,
              error:
                result.error?.message ??
                'Some keys failed validation after all retries'
            });
          } else {
            successfulLocales++;
            translations[result.locale] = result.translation as
              string | Record<string, string>;
          }
        }

        // Log output and scores on the root span
        const allFailed =
          Object.keys(translations).length === 0 && errors.length > 0;
        span.log({
          output: {
            outcome: allFailed ? 'failure' : 'success',
            successful_locales: successfulLocales,
            failed_locales: errors.length,
            partial_locales: partialLocales.length
          },
          scores: {
            success_rate:
              locales.length > 0 ? successfulLocales / locales.length : 0
          },
          metadata: {
            total_duration_ms: Date.now() - startTime,
            total_retries: totalRetries,
            successful_locales: successfulLocales,
            failed_locales: errors.length,
            partial_locales: partialLocales.length,
            ...requestContext
          },
          tags: [
            'translation',
            allFailed ? 'response-failure' : 'response-success'
          ]
        });

        console.log(
          `[${requestId}] Done | ${successfulLocales}/${locales.length} locales OK (${partialLocales.length} partial), ${totalRetries} retries, ${Date.now() - startTime}ms`
        );

        if (allFailed) {
          return c.json({ error: 'Translation failed', details: errors }, 500);
        }

        // The legacy top-level `model` field used to echo `primaryModel`,
        // which lied when runtime fallback produced output. Replaced by
        // per-locale `meta[locale].model` reporting the adapter that
        // actually executed for that locale. See
        // changelog/2026-04-29-meta-model-in-response.md and AGENTS.md
        // (section on FALLBACK_MODEL response shape).
        return c.json({
          success: partialLocales.length === 0,
          original: inputText,
          translations,
          meta,
          ...(partialLocales.length > 0 && { partialLocales }),
          ...(errors.length > 0 && { errors })
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        const isTimeout = error instanceof TimeoutError;
        console.error(`[${requestId}] Unhandled error | ${errorMessage}`);
        span.log({
          error: {
            type: isTimeout ? 'request_timeout' : 'unhandled_exception',
            message: errorMessage
          },
          metadata: {
            total_duration_ms: Date.now() - startTime,
            request_timeout_ms: REQUEST_TIMEOUT_MS,
            llm_timeout_ms: LLM_TIMEOUT_MS,
            ...requestContext
          },
          tags: [isTimeout ? 'request-timeout' : 'unhandled-exception']
        });
        return c.json(
          { error: 'Translation failed', details: errorMessage },
          isTimeout ? 504 : 500
        );
      }
    },
    { name: 'translate' }
  );

  // Wait for in-flight locale spans to settle before flushing.
  // If settlement hangs, continue after a bounded timeout and flush anyway.
  c.executionCtx.waitUntil(
    withTimeout(
      Promise.allSettled(localeTranslations),
      BACKGROUND_SETTLE_TIMEOUT_MS,
      `Background settle timed out after ${BACKGROUND_SETTLE_TIMEOUT_MS}ms`
    )
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : 'Unknown settle error';
        console.warn(`[${requestId}] waitUntil settle warning | ${message}`);
      })
      .then(() => flushBraintrust())
  );

  return response;
});

export default app;

type RequestContextMeta = {
  node_env: string;
  request_origin: string;
  request_referer: string;
  cf_ray: string;
  request_source: string;
  ci_job_id: string;
  caller_origin: string;
};

function getRawRequestContext(req: {
  method: string;
  url: string;
  header: (name: string) => string | undefined;
}): RequestContextMeta {
  const request_origin = req.header('origin') ?? '';
  const request_referer = req.header('referer') ?? '';
  const request_source = req.header('x-request-source') ?? '';
  const ci_job_id = req.header('x-ci-job-id') ?? '';

  const caller_origin = classifyCallerOrigin({
    request_origin,
    request_referer,
    request_source,
    ci_job_id
  });

  return {
    node_env: process.env['NODE_ENV'] ?? '',
    request_origin,
    request_referer,
    cf_ray: req.header('cf-ray') ?? '',
    request_source,
    ci_job_id,
    caller_origin
  };
}

type CallerOriginInputs = {
  request_origin: string;
  request_referer: string;
  request_source: string;
  ci_job_id: string;
};

/**
 * Pure classifier that derives a normalized `caller_origin` label
 * from already-captured headers.
 *
 * Priority order:
 *   1. `x-request-source` (verbatim, lowercased) — explicit self-identification.
 *   2. `x-ci-job-id` present → `'ci'`.
 *   3. `Origin` / `Referer` host inspection → `'ui-dev'` or the host.
 *   4. Fallback → `'unknown'`.
 */
export function classifyCallerOrigin(inputs: CallerOriginInputs): string {
  const { request_origin, request_referer, request_source, ci_job_id } = inputs;

  // 1. Explicit self-identification — pass through verbatim (lowercased).
  if (request_source && request_source.trim().length > 0) {
    return request_source.trim().toLowerCase();
  }

  // 2. CI job id present.
  if (ci_job_id && ci_job_id.trim().length > 0) {
    return 'ci';
  }

  // 3. Origin / Referer host inspection.
  const host = extractHost(request_origin) ?? extractHost(request_referer);
  if (host) {
    if (host === 'localhost' || host === '127.0.0.1') return 'ui-dev';
    return host;
  }

  // 4. Fallback.
  return 'unknown';
}

function extractHost(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}
