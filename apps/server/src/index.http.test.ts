import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTranslateText, mockWithTimeout, TimeoutErrorMock, spanLog } =
  vi.hoisted(() => {
    class TimeoutErrorMock extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TimeoutError';
      }
    }

    return {
      mockTranslateText: vi.fn(),
      mockWithTimeout: vi.fn(<T>(promise: Promise<T>) => promise),
      TimeoutErrorMock,
      spanLog: vi.fn()
    };
  });

vi.mock('./logger', () => ({
  initBraintrust: vi.fn(),
  traced: vi.fn(
    async (
      callback: (span: { log: typeof spanLog }) => unknown | Promise<unknown>
    ) => callback({ log: spanLog })
  ),
  flushBraintrust: vi.fn(async () => {})
}));

vi.mock('./translate-text', () => ({
  translateText: mockTranslateText
}));

vi.mock('./utils', () => ({
  withTimeout: mockWithTimeout,
  TimeoutError: TimeoutErrorMock
}));

import app from './index';
import { ValidModel } from './llm-adapters';
import type { TranslateTextParams } from './translate-text';

function makeEnv() {
  return {
    AI: {} as Ai,
    ANTHROPIC_API_KEY: 'test-key',
    BRAINTRUST_API_KEY: 'test-key',
    BRAINTRUST_API_URL: 'https://braintrust.example.com',
    BRAINTRUST_PROJECT_NAME: 'test-project',
    BRAINTRUST_CF_ACCESS_CLIENT_ID: 'test-client-id',
    BRAINTRUST_CF_ACCESS_CLIENT_SECRET: 'test-client-secret'
  };
}

/**
 * Returns a properly-typed `ExecutionContext` stub for app.fetch tests.
 * Replaces scattered `makeCtx()`
 * literals so the tests satisfy RFC-009 (no `any`). Function-valued members
 * are `vi.fn()` mocks; `props` is `undefined` because the worker code under
 * test never reads it.
 */
function makeCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    abort: vi.fn(),
    exports: {} as Cloudflare.Exports,
    props: undefined,
    tracing: {} as Tracing
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('https://api.example.com/api/translate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/',
      'cf-ray': 'abc123-SJC',
      'x-request-source': 'vitest-http-suite'
    },
    body: JSON.stringify(body)
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('translate endpoint status behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslateText.mockReset();
    mockWithTimeout.mockReset();
    mockWithTimeout.mockImplementation(<T>(promise: Promise<T>) => promise);
    spanLog.mockReset();
  });

  it('returns 400 for schema validation errors', async () => {
    const response = await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'invalid-locale' }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);
  });

  it('rejects duplicate target locales before invoking the provider', async () => {
    const response = await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'pt-BR,pt-BR' }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      'Duplicate target locales are not allowed'
    );
    expect(mockTranslateText).not.toHaveBeenCalled();
  });

  it('returns 400 for token limit exceeded', async () => {
    const response = await app.fetch(
      makeRequest({
        text: 'a '.repeat(20_000),
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    const json = await readJson(response);

    expect(response.status).toBe(400);
    expect(json.error).toBe('Token limit exceeded');
  });

  it('returns 200 for full success', async () => {
    mockTranslateText.mockResolvedValue({
      locale: 'pt-BR',
      translation: 'Ola mundo',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 10,
          promptTokens: 5,
          completionTokens: 5,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.kimi2_5
    });

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.translations).toEqual({ 'pt-BR': 'Ola mundo' });
    // The response no longer carries a top-level `model` field; per-locale
    // execution attribution lives in `meta[locale].model`. See
    // changelog/2026-04-29-meta-model-in-response.md.
    expect(json.model).toBeUndefined();
    expect(json.meta).toEqual({ 'pt-BR': { model: 'kimi2_5' } });

    // Verify caller_origin lands on root-span logs.
    const events = spanLog.mock.calls.map(([event]) => event);
    const eventWithMeta = events.find(
      (event) => event?.metadata?.caller_origin
    );
    expect(eventWithMeta).toBeTruthy();
    // x-request-source: vitest-http-suite passes through verbatim.
    expect(eventWithMeta.metadata.caller_origin).toBe('vitest-http-suite');
  });

  it('reports the fallback model in meta when fallback produced the translation', async () => {
    // Simulate `translateText` reporting that the fallback adapter (qwen)
    // produced output even though the request asked for kimi2_5.
    // This is the exact bug-fix scenario: top-level `model` would have
    // lied; the per-locale `meta[locale].model` must report `qwen`.
    mockTranslateText.mockResolvedValueOnce({
      locale: 'es-ES',
      translation: 'Hola',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 5,
          promptTokens: 0,
          completionTokens: 0,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.qwen
    });

    const response = await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'es-ES' }), // no client model -> fallback eligible
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.meta).toEqual({ 'es-ES': { model: 'qwen' } });
  });

  it('accepts requests without a model field (uses server default)', async () => {
    mockTranslateText.mockResolvedValueOnce({
      locale: 'es-ES',
      translation: 'Hola',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 5,
          promptTokens: 0,
          completionTokens: 0,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.kimi2_5
    });

    const response = await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'es-ES' }), // NO model field
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(200);
    // The handler should have called translateText with the server default model.
    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const callArgs = mockTranslateText.mock.calls[0][0];
    expect(callArgs.model).toBe(ValidModel.kimi2_5);
  });

  it('passes fallbackModel=null when client explicitly specifies a model', async () => {
    mockTranslateText.mockResolvedValueOnce({
      locale: 'es-ES',
      translation: 'Hola',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 5,
          promptTokens: 0,
          completionTokens: 0,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.llama
    });

    await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'es-ES', model: 'llama' }),
      makeEnv(),
      makeCtx()
    );

    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const callArgs: TranslateTextParams = mockTranslateText.mock.calls[0][0];
    expect(callArgs.model).toBe(ValidModel.llama);
    expect(callArgs.fallbackModel).toBeNull();
  });

  it('passes fallbackModel=qwen when client omits the model field', async () => {
    mockTranslateText.mockResolvedValueOnce({
      locale: 'es-ES',
      translation: 'Hola',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 5,
          promptTokens: 0,
          completionTokens: 0,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.kimi2_5
    });

    await app.fetch(
      makeRequest({ text: 'Hello', targetLocale: 'es-ES' }),
      makeEnv(),
      makeCtx()
    );

    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const callArgs: TranslateTextParams = mockTranslateText.mock.calls[0][0];
    expect(callArgs.model).toBe(ValidModel.kimi2_5);
    expect(callArgs.fallbackModel).toBe(ValidModel.qwen);
  });

  it('returns 200 with partial success payload', async () => {
    mockTranslateText.mockResolvedValueOnce({
      locale: 'pt-BR',
      translation: { welcome: 'Ola' },
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 10,
          promptTokens: 5,
          completionTokens: 5,
          errors: []
        }
      ],
      outcome: 'partial_success',
      modelUsed: ValidModel.kimi2_5,
      error: { type: 'retry_exhausted', message: 'Some keys failed' }
    });

    const response = await app.fetch(
      makeRequest({
        text: '{"welcome":"Hello"}',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.partialLocales).toHaveLength(1);
    expect(json.translations).toEqual({ 'pt-BR': { welcome: 'Ola' } });
  });

  it('returns 500 when all locales fail', async () => {
    mockTranslateText.mockResolvedValue({
      locale: 'pt-BR',
      translation: '',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 10,
          promptTokens: 0,
          completionTokens: 0,
          errors: [{ type: 'llm_call_failed', message: 'bad' }]
        }
      ],
      outcome: 'failure',
      modelUsed: ValidModel.kimi2_5,
      error: { type: 'retry_exhausted', message: 'Failed for pt-BR' }
    });

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(500);
    expect(json.error).toBe('Translation failed');
    expect(Array.isArray(json.details)).toBe(true);
  });

  it('returns 500 for non-timeout unhandled exceptions', async () => {
    mockTranslateText.mockImplementation(() => {
      throw new Error('boom');
    });

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(500);
    expect(json.error).toBe('Translation failed');
    expect(json.details).toBe('boom');
  });

  it('returns 504 for timeout errors', async () => {
    mockWithTimeout.mockRejectedValueOnce(
      new TimeoutErrorMock('Request timed out after 960000ms')
    );

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );
    const json = await readJson(response);

    expect(response.status).toBe(504);
    expect(json.error).toBe('Translation failed');
    expect(json.details).toContain('Request timed out');
  });
});

describe('guardrail mode env var threading', () => {
  /**
   * Mocks a single successful translate call and returns the first call's
   * params so we can inspect what `index.ts` passed to `translateText`.
   */
  const successfulTranslate = () => {
    mockTranslateText.mockResolvedValue({
      locale: 'pt-BR',
      translation: 'Ola mundo',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 10,
          promptTokens: 5,
          completionTokens: 5,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.kimi2_5
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslateText.mockReset();
    mockWithTimeout.mockReset();
    mockWithTimeout.mockImplementation(<T>(promise: Promise<T>) => promise);
  });

  it('defaults to guardrailMode="off" when env var is unset', async () => {
    successfulTranslate();
    await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(), // no GUARDRAIL_MODE
      makeCtx()
    );

    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const params = mockTranslateText.mock.calls[0][0];
    expect(params.guardrailMode).toBe('off');
    expect(params.logGuardrailMatches).toBe(false);
  });

  it('passes guardrailMode="shadow" through from env', async () => {
    successfulTranslate();
    const env = { ...makeEnv(), GUARDRAIL_MODE: 'shadow' };

    await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      env,
      makeCtx()
    );

    const params = mockTranslateText.mock.calls[0][0];
    expect(params.guardrailMode).toBe('shadow');
  });

  it('passes guardrailMode="enforce" through from env', async () => {
    successfulTranslate();
    const env = { ...makeEnv(), GUARDRAIL_MODE: 'enforce' };

    await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      env,
      makeCtx()
    );

    const params = mockTranslateText.mock.calls[0][0];
    expect(params.guardrailMode).toBe('enforce');
  });

  it('falls back to "off" with a warning on invalid mode (does not throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    successfulTranslate();
    const env = { ...makeEnv(), GUARDRAIL_MODE: 'bogus' };

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      env,
      makeCtx()
    );

    expect(response.status).toBe(200);
    const params = mockTranslateText.mock.calls[0][0];
    expect(params.guardrailMode).toBe('off');

    // Structured-log contract: the warning is emitted as a JSON string with
    // a stable `event` name and the raw value that was rejected. Tests
    // assert on the parsed payload to avoid coupling to string formatting.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArg = warnSpy.mock.calls[0][0];
    expect(typeof warnArg).toBe('string');
    const parsed = JSON.parse(warnArg as string);
    expect(parsed).toMatchObject({
      event: 'guardrail_mode_invalid',
      raw: 'bogus',
      fallback: 'off'
    });
    warnSpy.mockRestore();
  });

  it('passes logGuardrailMatches=true only when env var is literally "true"', async () => {
    successfulTranslate();

    const envTrue = { ...makeEnv(), BRAINTRUST_LOG_GUARDRAIL_MATCHES: 'true' };
    await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      envTrue,
      makeCtx()
    );
    expect(mockTranslateText.mock.calls[0][0].logGuardrailMatches).toBe(true);

    // Any other value is falsey.
    mockTranslateText.mockClear();
    const envOther = {
      ...makeEnv(),
      BRAINTRUST_LOG_GUARDRAIL_MATCHES: '1'
    };
    await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      envOther,
      makeCtx()
    );
    expect(mockTranslateText.mock.calls[0][0].logGuardrailMatches).toBe(false);
  });
});

describe('sourceLocale request handling', () => {
  // Suite covers UI-8255: sourceLocale parameter (default, validation,
  // and threading into translateText). Mirrors the guardrail-mode suite
  // pattern above.
  const successfulTranslate = (locale = 'pt-BR') => {
    mockTranslateText.mockResolvedValue({
      locale,
      translation: 'Ola mundo',
      attempts: [
        {
          attempt: 1,
          llmLatencyMs: 10,
          promptTokens: 5,
          completionTokens: 5,
          streamed: false,
          streamChunkCount: 0,
          streamFirstTokenMs: null,
          streamDurationMs: 0,
          errors: []
        }
      ],
      outcome: 'success',
      modelUsed: ValidModel.kimi2_5
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTranslateText.mockReset();
    mockWithTimeout.mockReset();
    mockWithTimeout.mockImplementation(<T>(promise: Promise<T>) => promise);
    spanLog.mockReset();
  });

  it('defaults sourceLocale to en-US when omitted', async () => {
    successfulTranslate();

    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(200);
    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const params: TranslateTextParams = mockTranslateText.mock.calls[0][0];
    expect(params.sourceLocale).toBe('en-US');
  });

  it('passes explicit sourceLocale through to translateText', async () => {
    // Support team's primary use case: customer wrote in Japanese,
    // agent reads English. Asserts the field flows from the request
    // body through to translateText.
    successfulTranslate('en-US');

    await app.fetch(
      makeRequest({
        text: 'こんにちは',
        sourceLocale: 'ja-JP',
        targetLocale: 'en-US',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(mockTranslateText).toHaveBeenCalledTimes(1);
    const params: TranslateTextParams = mockTranslateText.mock.calls[0][0];
    expect(params.sourceLocale).toBe('ja-JP');
    expect(params.locale).toBe('en-US');
  });

  it('returns 400 when sourceLocale matches a targetLocale', async () => {
    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        sourceLocale: 'fr-FR',
        targetLocale: 'fr-FR,de-DE',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);
    const json = await readJson(response);
    // Hono's zValidator wraps the ZodError; the message is a stringified
    // array of issues. Assert on the substring rather than the full shape.
    expect(JSON.stringify(json)).toContain(
      'sourceLocale (fr-FR) cannot match a targetLocale'
    );
    expect(mockTranslateText).not.toHaveBeenCalled();
  });

  it('returns 400 when omitted sourceLocale defaults to a targetLocale (no en-US -> en-US LLM waste)', async () => {
    // Regression test for AI reviewer feedback (UI-8255 MR !85): the
    // superRefine must apply DEFAULT_SOURCE_LOCALE before the
    // source==target comparison, otherwise an omitted sourceLocale with
    // targetLocale="en-US" produces a wasted LLM call.
    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        // sourceLocale omitted on purpose — server resolves to en-US
        targetLocale: 'en-US',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);
    const json = await readJson(response);
    expect(JSON.stringify(json)).toContain(
      'sourceLocale (en-US) cannot match a targetLocale'
    );
    expect(mockTranslateText).not.toHaveBeenCalled();
  });

  it('returns 400 when sourceLocale is not in VALID_LOCALES', async () => {
    const response = await app.fetch(
      makeRequest({
        text: 'Hello world',
        sourceLocale: 'klingon-XX',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);
    expect(mockTranslateText).not.toHaveBeenCalled();
  });

  it('logs source_locale on the root span (observability for UI-8255 rollout)', async () => {
    successfulTranslate();

    await app.fetch(
      makeRequest({
        text: 'こんにちは',
        sourceLocale: 'ja-JP',
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    // Find any span event whose metadata records source_locale.
    const events = spanLog.mock.calls.map(([event]) => event);
    const eventWithSource = events.find(
      (event) => event?.metadata?.source_locale === 'ja-JP'
    );
    expect(eventWithSource).toBeTruthy();
  });
});
