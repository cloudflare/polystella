import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Minimal shape of events passed to `span.log(...)` in `translate-text.ts`
 * and related modules. This is a structural subset — production code may
 * pass additional fields we don't enumerate here.
 */
interface SpanLogEvent {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  error?: { type: string; message: string; [k: string]: unknown };
  tags?: string[];
}

/**
 * Shared `span.log` mock — populated once per `traced()` call and accessed
 * via `findSpanEvents()` so tests can inspect what was logged to Braintrust
 * during a given translateText invocation.
 */
const { spanLogs } = vi.hoisted<{ spanLogs: SpanLogEvent[] }>(() => ({
  spanLogs: []
}));

vi.mock('./logger', () => ({
  traced: vi.fn(
    async <T>(
      callback: (span: { log: (event: SpanLogEvent) => void }) => Promise<T>
    ) => {
      const log = vi.fn((event: SpanLogEvent) => {
        spanLogs.push(event);
      });
      return callback({ log });
    }
  )
}));

/**
 * Mock the LLM judge so it never consumes env.AI.run mock responses.
 * The judge is shadow-only and its own unit tests live in judge.test.ts.
 * Here we just need it to be inert so translation-level mock sequencing
 * stays predictable.
 */
vi.mock('./guardrail/judge', () => ({
  callJudge: vi.fn(async () => ({
    result: { ok: true, verdicts: [] },
    meta: {
      judgeModel: 'llama',
      translatorModel: 'kimi2_5',
      locale: 'es-ES',
      keysEvaluated: 0,
      keysFlagged: 0,
      flaggedKeys: [],
      latencyMs: 0
    }
  }))
}));

import { translateText, type TranslateTextParams } from './translate-text';
import { ErrorType } from './errors';

/** Clear accumulated span logs (call in `beforeEach`). */
function resetSpanLogs(): void {
  spanLogs.length = 0;
}

/** Find all span log events with matching metadata.event. */
function findSpanEvents(eventName: string): SpanLogEvent[] {
  return spanLogs.filter((evt) => evt.metadata?.['event'] === eventName);
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

/** Builds a mock Workers AI response in the kimi2_5 / qwen / glm shape */
function aiResponse(
  content: string | null,
  completionTokens = 42,
  promptTokens = 10
) {
  return {
    choices: [{ message: { content } }],
    usage: { completion_tokens: completionTokens, prompt_tokens: promptTokens }
  };
}

/** Creates a mock `env` whose `AI.run` resolves to `responses` in sequence */
function mockEnv(...responses: unknown[]) {
  const run = vi.fn();
  for (const r of responses) {
    run.mockResolvedValueOnce(r);
  }
  return {
    AI: { run } as unknown as Ai,
    ANTHROPIC_API_KEY: 'test-key'
  };
}

/** Default params — override per-test as needed */
function baseParams(
  overrides: Partial<TranslateTextParams> = {}
): TranslateTextParams {
  return {
    env: mockEnv(),
    sourceLocale: 'en-US',
    locale: 'es-ES',
    text: 'Hello world',
    model: 'kimi2_5',
    maxAttempts: 3,
    guardrailMode: 'off',
    logGuardrailMatches: false,
    ...overrides
  };
}

// ���─ Tests ─────────────────────────────────────────────────────────────────────

describe('translateText', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSpanLogs();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  // ── Plain text ────────────────────────────────────────────────────────────

  describe('plain text translation', () => {
    it('returns the translated string on success', async () => {
      const env = mockEnv(aiResponse('Hola mundo'));
      const result = await translateText(baseParams({ env }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toBe('Hola mundo');
      expect(result.locale).toBe('es-ES');
      expect(result.attempts).toHaveLength(1);
    });

    it('records output tokens and latency in the attempt', async () => {
      const env = mockEnv(aiResponse('Hola mundo', 100));
      const result = await translateText(baseParams({ env }));

      expect(result.attempts[0].completionTokens).toBe(100);
      expect(result.attempts[0].llmLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.attempts[0].errors).toHaveLength(0);
    });

    it('logs LLM metrics without the output', async () => {
      const env = mockEnv(aiResponse('Hola mundo'));

      await translateText(baseParams({ env, model: 'qwen' }));

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('llm_output')
      );
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(
        'Hola mundo'
      );
      expect(JSON.stringify(spanLogs)).not.toContain('Hola mundo');
    });

    it('streams kimi responses and records stream metrics', async () => {
      const stream = (async function* () {
        yield { choices: [{ delta: { content: 'Hola ' } }] };
        yield {
          choices: [{ delta: { content: 'mundo' } }],
          usage: { prompt_tokens: 21, completion_tokens: 2 }
        };
      })();
      const env = mockEnv(stream);

      const result = await translateText(baseParams({ env }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toBe('Hola mundo');
      expect(result.attempts[0].streamed).toBe(true);
      expect(result.attempts[0].streamChunkCount).toBe(2);
      expect(result.attempts[0].streamFirstTokenMs).not.toBeNull();
      expect(result.attempts[0].promptTokens).toBe(21);
      expect(result.attempts[0].completionTokens).toBe(2);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('llm_output streamed=true')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('chunks=2')
      );
      expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(
        'Hola mundo'
      );
    });
  });

  // ── JSON translation ──────────────────────────────────────────────────────

  describe('JSON translation', () => {
    it('returns translated catalog when all keys pass validation', async () => {
      const source = JSON.stringify({ greeting: 'Hello', farewell: 'Goodbye' });
      const llmOutput = JSON.stringify({ greeting: 'Hola', farewell: 'Adiós' });

      const env = mockEnv(aiResponse(llmOutput));
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toEqual({
        greeting: 'Hola',
        farewell: 'Adiós'
      });
    });

    it('preserves placeholders in translated values', async () => {
      const source = JSON.stringify({
        welcome: 'Hello {{name}}, you have %{count} items'
      });
      const llmOutput = JSON.stringify({
        welcome: 'Hola {{name}}, tienes %{count} artículos'
      });

      const env = mockEnv(aiResponse(llmOutput));
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect((result.translation as Record<string, string>).welcome).toBe(
        'Hola {{name}}, tienes %{count} artículos'
      );
    });
  });

  // ── Empty response ────────────────────────────────────────────────────────

  describe('empty LLM response', () => {
    it('retries on empty response and succeeds on next attempt', async () => {
      const env = mockEnv(
        aiResponse(null), // attempt 1: empty
        aiResponse('Hola mundo') // attempt 2: success
      );
      const result = await translateText(baseParams({ env }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toBe('Hola mundo');
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].errors[0].type).toBe(
        ErrorType.LLM_EMPTY_RESPONSE
      );
    });

    it('fails after all attempts return empty', async () => {
      const env = mockEnv(aiResponse(null), aiResponse(null), aiResponse(null));
      const result = await translateText(baseParams({ env }));

      expect(result.outcome).toBe('failure');
      expect(result.error?.type).toBe(ErrorType.RETRY_EXHAUSTED);
      expect(result.attempts).toHaveLength(3);
    });
  });

  // ── Malformed JSON ────────────────────────────────────────────────────────

  describe('malformed JSON response', () => {
    it('retries when LLM returns non-object for JSON input', async () => {
      const source = JSON.stringify({ key: 'value' });
      const env = mockEnv(
        aiResponse('not valid json'), // attempt 1: string, not object
        aiResponse(JSON.stringify({ key: 'valor' })) // attempt 2: valid
      );
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].errors[0].type).toBe(
        ErrorType.LLM_MALFORMED_JSON
      );
    });
  });

  // ── Missing keys ──────────────────────────────────────────────────────────

  describe('missing translation keys', () => {
    it('retries only the missing keys on the next attempt', async () => {
      const source = JSON.stringify({ a: 'Alpha', b: 'Beta' });

      const env = mockEnv(
        aiResponse(JSON.stringify({ a: 'Alfa' })), // attempt 1: 'b' missing
        aiResponse(JSON.stringify({ b: 'Beta-ES' })) // attempt 2: 'b' provided
      );
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toEqual({ a: 'Alfa', b: 'Beta-ES' });
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].errors[0].type).toBe(
        ErrorType.MISSING_TRANSLATION_KEY
      );

      // Verify second call received only the failed key
      const secondCallInput = (env.AI.run as ReturnType<typeof vi.fn>).mock
        .calls[1][1];
      const messagesContent = secondCallInput.messages[1].content;
      expect(messagesContent).toContain('"b"');
      expect(messagesContent).not.toContain('"a"');
    });
  });

  // ── Placeholder mismatch ──────────────────────────────────────────────────

  describe('placeholder validation failures', () => {
    it('retries key when placeholders are dropped by LLM', async () => {
      const source = JSON.stringify({ msg: 'Hello {{name}}' });

      const env = mockEnv(
        aiResponse(JSON.stringify({ msg: 'Hola' })), // attempt 1: placeholder dropped
        aiResponse(JSON.stringify({ msg: 'Hola {{name}}' })) // attempt 2: correct
      );
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect((result.translation as Record<string, string>).msg).toBe(
        'Hola {{name}}'
      );
      expect(result.attempts[0].errors[0].type).toBe(
        ErrorType.PLACEHOLDER_MISMATCH
      );
    });

    it('retries key when component placeholders are dropped', async () => {
      const source = JSON.stringify({ msg: 'Click <0>here</0> to continue' });

      const env = mockEnv(
        aiResponse(JSON.stringify({ msg: 'Haga clic aquí para continuar' })), // attempt 1: tags dropped
        aiResponse(
          JSON.stringify({ msg: 'Haga clic <0>aquí</0> para continuar' })
        ) // attempt 2: correct
      );
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect(result.attempts[0].errors[0].type).toBe(
        ErrorType.PLACEHOLDER_MISMATCH
      );
    });
  });

  // ── LLM call exception ────────────────────────────────────────────────────

  describe('LLM call failure', () => {
    it('retries a new streaming attempt when streamed run throws', async () => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error('Workers AI timeout'))
        .mockResolvedValueOnce(aiResponse('Hola mundo'));

      const env = {
        AI: { run } as unknown as Ai,
        ANTHROPIC_API_KEY: 'test-key'
      };
      const result = await translateText(baseParams({ env }));

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].errors[0].type).toBe(ErrorType.LLM_CALL_FAILED);
      expect(result.attempts[0].errors[0].message).toBe('Workers AI timeout');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('returns failure after all attempts throw', async () => {
      const run = vi.fn().mockRejectedValue(new Error('Service unavailable'));

      const env = {
        AI: { run } as unknown as Ai,
        ANTHROPIC_API_KEY: 'test-key'
      };
      const result = await translateText(baseParams({ env, maxAttempts: 2 }));

      expect(result.outcome).toBe('failure');
      expect(result.error?.type).toBe(ErrorType.RETRY_EXHAUSTED);
      expect(result.attempts).toHaveLength(2);
    });

    it('times out hung LLM calls and records attempts', async () => {
      const run = vi.fn(() => new Promise(() => {}));

      const env = {
        AI: { run } as unknown as Ai,
        ANTHROPIC_API_KEY: 'test-key'
      };
      const result = await translateText(
        baseParams({ env, maxAttempts: 2, llmTimeoutMs: 5 })
      );

      expect(result.outcome).toBe('failure');
      expect(result.error?.type).toBe(ErrorType.RETRY_EXHAUSTED);
      expect(result.error?.message).toContain('timed out');
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].errors[0].type).toBe(ErrorType.LLM_CALL_FAILED);
      expect(result.attempts[0].llmLatencyMs).toBeGreaterThan(0);
    });
  });

  // ── Partial success ───────────────────────────────────────────────────────

  describe('partial success', () => {
    it('returns partial_success when some keys succeed but retries exhaust', async () => {
      const source = JSON.stringify({ a: 'Alpha', b: 'Hello {{name}}' });

      const env = mockEnv(
        // attempt 1: 'a' ok, 'b' has placeholder dropped
        aiResponse(JSON.stringify({ a: 'Alfa', b: 'Hola' })),
        // attempt 2: 'b' still wrong
        aiResponse(JSON.stringify({ b: 'Hola' })),
        // attempt 3: 'b' still wrong
        aiResponse(JSON.stringify({ b: 'Hola' }))
      );
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('partial_success');
      expect(result.translation).toEqual({ a: 'Alfa' });
      expect(result.error?.type).toBe(ErrorType.RETRY_EXHAUSTED);
    });
  });

  // ── maxAttempts = 1 ───────────────────────────────────────────────────────

  describe('single attempt mode', () => {
    it('does not retry when maxAttempts is 1', async () => {
      const env = mockEnv(aiResponse(null));
      const result = await translateText(baseParams({ env, maxAttempts: 1 }));

      expect(result.outcome).toBe('failure');
      expect(result.attempts).toHaveLength(1);
      expect(env.AI.run).toHaveBeenCalledTimes(1);
    });
  });

  // ── Sanitization ──────────────────────────────────────────────────────────

  describe('response sanitization', () => {
    it('handles markdown code fence wrapped JSON', async () => {
      const source = JSON.stringify({ key: 'value' });
      const fenced = '```json\n{"key": "valor"}\n```';

      const env = mockEnv(aiResponse(fenced));
      const result = await translateText(baseParams({ env, text: source }));

      expect(result.outcome).toBe('success');
      expect(result.translation).toEqual({ key: 'valor' });
    });
  });

  // ── Content guardrail integration ──────────────────────────────────────────

  describe('content guardrail', () => {
    /**
     * Pull a real es-ES wordlist term at runtime. Same trick as the
     * guardrail/validation test files — exercises the matcher with a real
     * flagging term without committing profanity to the repo.
     */
    const getFlaggingTerm = async (): Promise<string> => {
      const { __testing } = await import('./guardrail');
      const m = __testing.MATCHERS['es-ES'];
      if (m.kind !== 'latin') throw new Error('expected latin matcher');
      const candidate = m.regexes.find((r) => /^\p{L}+$/u.test(r.term));
      if (!candidate) throw new Error('no purely-alphabetic term available');
      return candidate.term;
    };

    it('default guardrail=off: a would-flag translation succeeds on first attempt', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const llmOutput = JSON.stringify({ greeting: `Hola ${term}` });

      const env = mockEnv(aiResponse(llmOutput));
      const result = await translateText(
        baseParams({ env, text: source })
        // no guardrailMode → defaults to 'off'
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(1);
      // No guardrail error was recorded because the check was never invoked.
      const guardrailErrors = result.attempts[0].errors.filter(
        (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
      );
      expect(guardrailErrors).toHaveLength(0);
    });

    it('shadow mode: flagged translation succeeds, flag is logged to Braintrust but NOT to attempt errors', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const llmOutput = JSON.stringify({ greeting: `Hola ${term}` });

      const env = mockEnv(aiResponse(llmOutput));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'shadow' })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(1);

      // Shadow mode MUST NOT push to attemptRecord.errors — doing so would
      // cause logSpanResult to stamp a top-level `error:` on the locale
      // span via its allErrors aggregation, polluting error dashboards for
      // translations that actually succeeded.
      const attemptGuardrailErrors = result.attempts[0].errors.filter(
        (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
      );
      expect(attemptGuardrailErrors).toHaveLength(0);

      // But the flag IS logged to Braintrust as a `guardrail_flagged` event
      // (informational) with `metadata` only, NO `error` field.
      const flagEvents = findSpanEvents('guardrail_flagged');
      expect(flagEvents).toHaveLength(1);
      const [flagEvent] = flagEvents;
      if (!flagEvent) throw new Error('expected one flag event');
      expect(flagEvent.error).toBeUndefined();
      const metadata = flagEvent.metadata;
      if (!metadata) throw new Error('expected flag event to have metadata');
      expect(metadata['guardrail_mode']).toBe('shadow');
      expect(metadata['match_count']).toBeGreaterThan(0);
      expect(metadata['key']).toBe('greeting');
      // Matched term MUST NOT appear in metadata by default.
      expect(JSON.stringify(flagEvent)).not.toContain(term);
    });

    it('enforce mode: flagged translation logs a guardrail event WITH an error field', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });
      const clean = JSON.stringify({ greeting: 'Hola' });

      const env = mockEnv(aiResponse(dirty), aiResponse(clean));
      await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      // Exactly one flag event (attempt 1); attempt 2 was clean.
      const flagEvents = findSpanEvents('guardrail_flagged');
      expect(flagEvents).toHaveLength(1);
      const [flagEvent] = flagEvents;
      if (!flagEvent) throw new Error('expected one flag event');
      const flagError = flagEvent.error;
      if (!flagError) {
        throw new Error(
          'expected flag event to have an error field in enforce mode'
        );
      }
      expect(flagError.type).toBe(ErrorType.CONTENT_GUARDRAIL_FLAGGED);
      const metadata = flagEvent.metadata;
      if (!metadata) throw new Error('expected flag event to have metadata');
      expect(metadata['guardrail_mode']).toBe('enforce');
    });

    it('enforce mode: a flagged translation triggers retry, eventually succeeding on a clean response', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });
      const clean = JSON.stringify({ greeting: 'Hola' });

      const env = mockEnv(aiResponse(dirty), aiResponse(clean));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);
      // First attempt flagged, second attempt clean.
      const firstAttemptGuardrailErrors = result.attempts[0].errors.filter(
        (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
      );
      expect(firstAttemptGuardrailErrors).toHaveLength(1);
      const secondAttemptGuardrailErrors = result.attempts[1].errors.filter(
        (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
      );
      expect(secondAttemptGuardrailErrors).toHaveLength(0);
      expect(result.translation).toEqual({ greeting: 'Hola' });
    });

    it('enforce mode: exhausts retries when every attempt is flagged', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });

      const env = mockEnv(
        aiResponse(dirty),
        aiResponse(dirty),
        aiResponse(dirty)
      );
      const result = await translateText(
        baseParams({
          env,
          text: source,
          guardrailMode: 'enforce',
          maxAttempts: 3
        })
      );

      // All three attempts fail the guardrail — no keys succeed, outcome=failure.
      expect(result.outcome).toBe('failure');
      expect(result.attempts).toHaveLength(3);
      for (const attempt of result.attempts) {
        const guardrailErrors = attempt.errors.filter(
          (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
        );
        expect(guardrailErrors.length).toBeGreaterThan(0);
      }
    });

    it('enforce mode on out-of-scope locale: guardrail is skipped, translation proceeds normally', async () => {
      // ar-EG is NOT in GUARDRAIL_SUPPORTED_LOCALES. checkProfanity returns
      // skipped=true, validator records no flag, translation succeeds even
      // with content that WOULD flag in a supported locale.
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const llmOutput = JSON.stringify({
        greeting: `hello ${term} world`
      });

      const env = mockEnv(aiResponse(llmOutput));
      const result = await translateText(
        baseParams({
          env,
          text: source,
          locale: 'ar-EG',
          guardrailMode: 'enforce'
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(1);
      const guardrailErrors = result.attempts[0].errors.filter(
        (e) => e.type === ErrorType.CONTENT_GUARDRAIL_FLAGGED
      );
      expect(guardrailErrors).toHaveLength(0);
    });
  });

  // ── Retry prompt escalation ────────────────────────────────────────────────

  describe('retry prompt escalation', () => {
    const getFlaggingTerm = async (): Promise<string> => {
      const { __testing } = await import('./guardrail');
      const m = __testing.MATCHERS['es-ES'];
      if (m.kind !== 'latin') throw new Error('expected latin matcher');
      const candidate = m.regexes.find((r) => /^\p{L}+$/u.test(r.term));
      if (!candidate) throw new Error('no purely-alphabetic term available');
      return candidate.term;
    };

    /**
     * Minimal shape of an adapter-formatted chat message (kimi2_5 default).
     * Tests only read role + content; additional fields are ignored.
     */
    interface ChatMessage {
      role: 'system' | 'user' | 'assistant';
      content: string;
    }

    type MockedEnv = ReturnType<typeof mockEnv>;
    type RunMock = ReturnType<typeof vi.fn>;

    /**
     * Access the underlying vi.fn() behind env.AI.run. Kept in one helper
     * so the pattern lives in exactly one place.
     */
    const runMock = (env: MockedEnv): RunMock =>
      env.AI.run as unknown as RunMock;

    /**
     * Runtime guard for an adapter-formatted input payload with a
     * `messages` array. Validates the shape before we read it rather than
     * blindly casting — satisfies RFC-009 (no unguarded `as`).
     */
    const hasMessages = (
      value: unknown
    ): value is { messages: ChatMessage[] } => {
      if (typeof value !== 'object' || value === null) return false;
      const maybe = value as { messages?: unknown };
      if (!Array.isArray(maybe.messages)) return false;
      // Verify each entry has the minimal ChatMessage shape.
      return maybe.messages.every(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as { role?: unknown }).role === 'string' &&
          typeof (m as { content?: unknown }).content === 'string'
      );
    };

    /**
     * Reach into the AI.run mock to get the messages passed on a specific
     * call. Uses `kimi2_5` default, so input shape is `{ messages, ... }`.
     */
    const messagesFromCall = (
      env: MockedEnv,
      callIndex: number
    ): ChatMessage[] => {
      const call = runMock(env).mock.calls[callIndex];
      if (call === undefined) {
        throw new Error(`No AI.run call at index ${callIndex}`);
      }
      const input = call[1];
      if (!hasMessages(input)) {
        throw new Error(
          `AI.run call[${callIndex}] did not match expected { messages: ChatMessage[] } shape`
        );
      }
      return input.messages;
    };

    const systemPromptFromCall = (
      env: MockedEnv,
      callIndex: number
    ): string => {
      const messages = messagesFromCall(env, callIndex);
      const system = messages.find((m) => m.role === 'system');
      return system?.content ?? '';
    };

    it('first attempt does not contain guardrail reinforcement', async () => {
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const source = JSON.stringify({ greeting: 'Hello' });
      const clean = JSON.stringify({ greeting: 'Hola' });

      const env = mockEnv(aiResponse(clean));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      expect(result.outcome).toBe('success');
      const firstSystem = systemPromptFromCall(env, 0);
      expect(firstSystem).not.toContain(
        'CONTENT GUARDRAIL RETRY REINFORCEMENT'
      );
      expect(firstSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    });

    it('second attempt includes tier-1 reinforcement after a first-attempt guardrail flag', async () => {
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });
      const clean = JSON.stringify({ greeting: 'Hola' });

      const env = mockEnv(aiResponse(dirty), aiResponse(clean));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);

      // First attempt: no reinforcement.
      expect(systemPromptFromCall(env, 0)).not.toContain(
        'CONTENT GUARDRAIL RETRY REINFORCEMENT'
      );
      // Second attempt: tier 1, not tier 2.
      const secondSystem = systemPromptFromCall(env, 1);
      expect(secondSystem).toContain('CONTENT GUARDRAIL RETRY REINFORCEMENT');
      expect(secondSystem).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
      expect(secondSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
    });

    it('third attempt includes tier-2 reinforcement when a key has been flagged twice', async () => {
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });
      const clean = JSON.stringify({ greeting: 'Hola' });

      // Two consecutive flagged attempts, then clean.
      const env = mockEnv(
        aiResponse(dirty),
        aiResponse(dirty),
        aiResponse(clean)
      );
      const result = await translateText(
        baseParams({
          env,
          text: source,
          guardrailMode: 'enforce',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(3);

      // Attempt 2 saw 1 prior flag → tier 1 only.
      const secondSystem = systemPromptFromCall(env, 1);
      expect(secondSystem).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
      expect(secondSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);

      // Attempt 3 saw 2 prior flags on the same key → tier 1 + tier 2.
      const thirdSystem = systemPromptFromCall(env, 2);
      expect(thirdSystem).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
      expect(thirdSystem).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
    });

    it('shadow mode does not trigger escalation (no retry means no next attempt to reinforce)', async () => {
      const term = await getFlaggingTerm();
      const source = JSON.stringify({ greeting: 'Hello' });
      const dirty = JSON.stringify({ greeting: `Hola ${term}` });

      const env = mockEnv(aiResponse(dirty));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'shadow' })
      );

      expect(result.outcome).toBe('success'); // shadow never fails
      expect(result.attempts).toHaveLength(1);
      // Only one AI.run call — no retry happened, so no second prompt to inspect.
      expect(runMock(env).mock.calls).toHaveLength(1);
    });

    it('placeholder-only retry does not include guardrail reinforcement', async () => {
      // Placeholder retries are NOT content_guardrail retries; prompt stays
      // bare even though a retry occurred.
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const source = JSON.stringify({ welcome: 'Hello {{name}}' });
      // First attempt: placeholder missing. Second attempt: correct.
      const badPlaceholder = JSON.stringify({ welcome: 'Hola' });
      const clean = JSON.stringify({ welcome: 'Hola {{name}}' });

      const env = mockEnv(aiResponse(badPlaceholder), aiResponse(clean));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);
      // Second attempt's system prompt has no guardrail reinforcement,
      // because the retry trigger was a placeholder failure, not a flag.
      const secondSystem = systemPromptFromCall(env, 1);
      expect(secondSystem).not.toContain(
        'CONTENT GUARDRAIL RETRY REINFORCEMENT'
      );
      expect(secondSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    });

    it('mixed retry batch: reinforcement is driven only by guardrail-flagged keys in the batch', async () => {
      // Attempt 1: key `a` flagged by guardrail, key `b` has placeholder
      // mismatch, key `c` succeeds. Retry batch = {a, b}.
      // Retry prompt should include tier-1 reinforcement because `a` was
      // flagged, but should NOT escalate to tier 2 just because `b` is
      // also in the batch.
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const term = await getFlaggingTerm();
      const source = JSON.stringify({
        a: 'Hello',
        b: 'Bye {{name}}',
        c: 'Thanks'
      });
      const attempt1 = JSON.stringify({
        a: `Hola ${term}`, // guardrail flag
        b: 'Adios', // placeholder mismatch (missing {{name}})
        c: 'Gracias' // clean
      });
      const attempt2 = JSON.stringify({
        a: 'Hola',
        b: 'Adios {{name}}'
      });

      const env = mockEnv(aiResponse(attempt1), aiResponse(attempt2));
      const result = await translateText(
        baseParams({ env, text: source, guardrailMode: 'enforce' })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);

      const secondSystem = systemPromptFromCall(env, 1);
      // Tier 1 fires because `a` was flagged once and is in the retry batch.
      expect(secondSystem).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
      // Tier 2 does NOT fire — no key was flagged 2+ times.
      expect(secondSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
    });

    it('retry batch with only placeholder failures (no guardrail history) omits reinforcement', async () => {
      // Attempt 1: key `a` flagged AND succeeds on retry somehow? Not
      // realistic. Simpler case: attempt 1 has two distinct failure reasons,
      // attempt 2 clears the guardrail key but not the placeholder key.
      // Attempt 3's retry batch contains only the placeholder-only key,
      // which has no guardrail history → no reinforcement.
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const term = await getFlaggingTerm();
      const source = JSON.stringify({
        a: 'Hello',
        b: 'Bye {{name}}'
      });
      const attempt1 = JSON.stringify({
        a: `Hola ${term}`, // guardrail flag
        b: 'Adios' // placeholder mismatch
      });
      const attempt2 = JSON.stringify({
        a: 'Hola', // now clean — moves to successfulCatalog
        b: 'Adios' // still missing {{name}} — stays in failedCatalog
      });
      const attempt3 = JSON.stringify({ b: 'Adios {{name}}' });

      const env = mockEnv(
        aiResponse(attempt1),
        aiResponse(attempt2),
        aiResponse(attempt3)
      );
      const result = await translateText(
        baseParams({
          env,
          text: source,
          guardrailMode: 'enforce',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(3);

      // Attempt 2 retry batch was {a, b}. `a` was flagged once → tier 1.
      expect(systemPromptFromCall(env, 1)).toContain(
        GUARDRAIL_RETRY_REINFORCEMENT.tier1
      );
      // Attempt 3 retry batch is {b} only. `b` has never been flagged →
      // no reinforcement even though the locale has flag history on `a`.
      const thirdSystem = systemPromptFromCall(env, 2);
      expect(thirdSystem).not.toContain(
        'CONTENT GUARDRAIL RETRY REINFORCEMENT'
      );
      expect(thirdSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    });

    it('shadow-mode flag on a passing key does NOT bleed guardrail reinforcement into a placeholder-driven retry', async () => {
      // Regression test for MR review feedback: in shadow mode, key `a` is
      // flagged by the guardrail but still succeeds (shadow never fails
      // validation). On the same attempt, key `b` fails placeholder
      // validation and schedules a retry. The retry batch = {b}, and key
      // `b` has no guardrail history — so the retry prompt must NOT carry
      // guardrail reinforcement. Before the fix, the counter for `a` was
      // incremented on the shadow flag, polluting the locale's flag
      // history. After the fix, shadow flags do not increment the counter
      // at all (it's gated on `!entryValidation.success`).
      const { GUARDRAIL_RETRY_REINFORCEMENT } = await import('./prompt-utils');
      const term = await getFlaggingTerm();
      const source = JSON.stringify({
        a: 'Hello',
        b: 'Bye {{name}}'
      });
      const attempt1 = JSON.stringify({
        a: `Hola ${term}`, // flagged (shadow — still succeeds)
        b: 'Adios' // placeholder mismatch — schedules retry
      });
      const attempt2 = JSON.stringify({ b: 'Adios {{name}}' });

      const env = mockEnv(aiResponse(attempt1), aiResponse(attempt2));
      const result = await translateText(
        baseParams({
          env,
          text: source,
          guardrailMode: 'shadow'
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(2);

      // The retry (attempt 2) was driven entirely by the placeholder
      // failure on key `b`. Key `a` had a shadow flag but never entered
      // the retry batch. System prompt for attempt 2 must be clean.
      const secondSystem = systemPromptFromCall(env, 1);
      expect(secondSystem).not.toContain(
        'CONTENT GUARDRAIL RETRY REINFORCEMENT'
      );
      expect(secondSystem).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    });
  });

  describe('fallback model', () => {
    it('runs the fallback model after primary exhausts retries and succeeds', async () => {
      const source = JSON.stringify({ greeting: 'Hello' });
      // Primary (kimi2_5) returns malformed for all 3 attempts; fallback (qwen) succeeds.
      const env = mockEnv(
        aiResponse('not valid'), // primary attempt 1 — malformed JSON
        aiResponse('not valid'), // primary attempt 2 — malformed JSON
        aiResponse('not valid'), // primary attempt 3 — malformed JSON
        aiResponse(JSON.stringify({ greeting: 'Hola' })) // fallback attempt — success
      );

      const result = await translateText(
        baseParams({
          env,
          text: source,
          model: 'kimi2_5',
          fallbackModel: 'qwen',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.translation).toEqual({ greeting: 'Hola' });
      expect(result.attempts).toHaveLength(4); // 3 primary + 1 fallback
      expect(env.AI.run).toHaveBeenCalledTimes(4);
      // Fallback success path attributes the locale to the fallback model.
      // This is the headline contract behind the API response `meta` field:
      // the model that actually produced output, not the requested primary.
      expect(result.modelUsed).toBe('qwen');

      // The fallback span event was emitted.
      const fallbackEvents = findSpanEvents('fallback_attempt_start');
      expect(fallbackEvents).toHaveLength(1);
      const md = fallbackEvents[0].metadata;
      if (!md) throw new Error('expected metadata');
      expect(md['locale']).toBe('es-ES');
      expect(md['primary_attempts_used']).toBe(3);
    });

    it('records fallback_used=true and fallback_model_id in the final locale span metadata when fallback runs', async () => {
      const source = JSON.stringify({ greeting: 'Hello' });
      const env = mockEnv(
        aiResponse('not valid'),
        aiResponse('not valid'),
        aiResponse('not valid'),
        aiResponse(JSON.stringify({ greeting: 'Hola' }))
      );

      await translateText(
        baseParams({
          env,
          text: source,
          model: 'kimi2_5',
          fallbackModel: 'qwen',
          maxAttempts: 3
        })
      );

      // The final locale span log includes the output and metrics.
      // Find the event with `output` defined and `metadata.outcome` set.
      const finalEvent = spanLogs.find(
        (e) => e.output !== undefined && e.metadata?.['outcome'] !== undefined
      );
      if (!finalEvent) throw new Error('expected final span event with output');
      const md = finalEvent.metadata;
      if (!md) throw new Error('expected metadata');
      expect(md['fallback_used']).toBe(true);
      expect(md['fallback_model_id']).toContain('qwen');
    });

    it('records fallback_used=false when fallback was not eligible', async () => {
      const env = mockEnv(aiResponse('Hola mundo'));
      await translateText(
        baseParams({
          env,
          model: 'kimi2_5'
          // fallbackModel omitted → null
        })
      );

      const finalEvent = spanLogs.find(
        (e) => e.output !== undefined && e.metadata?.['outcome'] !== undefined
      );
      if (!finalEvent) throw new Error('expected final span event with output');
      const md = finalEvent.metadata;
      if (!md) throw new Error('expected metadata');
      expect(md['fallback_used']).toBe(false);
      expect(md['fallback_model_id']).toBeNull();
    });

    it('does not run fallback when fallbackModel is null (simulates client-provided model)', async () => {
      const env = mockEnv(aiResponse(null), aiResponse(null), aiResponse(null));

      const result = await translateText(
        baseParams({
          env,
          model: 'kimi2_5',
          // fallbackModel intentionally omitted → null
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('failure');
      expect(result.attempts).toHaveLength(3); // no extra attempt
      expect(env.AI.run).toHaveBeenCalledTimes(3);
      expect(findSpanEvents('fallback_attempt_start')).toHaveLength(0);
    });

    it('does not run fallback when primary succeeds', async () => {
      const env = mockEnv(aiResponse('Hola mundo'));

      const result = await translateText(
        baseParams({
          env,
          model: 'kimi2_5',
          fallbackModel: 'qwen'
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.attempts).toHaveLength(1);
      expect(env.AI.run).toHaveBeenCalledTimes(1);
      expect(findSpanEvents('fallback_attempt_start')).toHaveLength(0);
    });

    it('does not run fallback when fallbackModel equals the primary model (defensive)', async () => {
      const env = mockEnv(aiResponse(null), aiResponse(null), aiResponse(null));

      const result = await translateText(
        baseParams({
          env,
          model: 'kimi2_5',
          fallbackModel: 'kimi2_5', // same as primary
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('failure');
      expect(result.attempts).toHaveLength(3); // no extra attempt
      expect(env.AI.run).toHaveBeenCalledTimes(3);
      expect(findSpanEvents('fallback_attempt_start')).toHaveLength(0);
    });

    it('rescues partial_success when fallback completes the failed keys', async () => {
      const source = JSON.stringify({ a: 'Alpha', b: 'Hello {{name}}' });
      const env = mockEnv(
        // Primary attempt 1: 'a' ok, 'b' has placeholder dropped.
        aiResponse(JSON.stringify({ a: 'Alfa', b: 'Hola' })),
        // Primary attempt 2: 'b' still wrong.
        aiResponse(JSON.stringify({ b: 'Hola' })),
        // Primary attempt 3: 'b' still wrong.
        aiResponse(JSON.stringify({ b: 'Hola' })),
        // Fallback attempt: 'b' correct.
        aiResponse(JSON.stringify({ b: 'Hola {{name}}' }))
      );

      const result = await translateText(
        baseParams({
          env,
          text: source,
          model: 'kimi2_5',
          fallbackModel: 'qwen',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.translation).toEqual({
        a: 'Alfa',
        b: 'Hola {{name}}'
      });
      expect(result.attempts).toHaveLength(4);
      expect(findSpanEvents('fallback_attempt_start')).toHaveLength(1);
      // When fallback rescues to a full success_json, attribution lands on
      // the fallback adapter that took the final attempt — even though
      // primary contributed key 'a' along the way. This matches the
      // simpler "fallback success" attribution; the multi-model truth is
      // observable via Braintrust span events (`fallback_used`,
      // `fallback_model_id`, per-attempt `model_id`).
      expect(result.modelUsed).toBe('qwen');
    });

    it('returns failure when both primary and fallback exhaust', async () => {
      const env = mockEnv(
        aiResponse(null), // primary 1
        aiResponse(null), // primary 2
        aiResponse(null), // primary 3
        aiResponse(null) // fallback
      );

      const result = await translateText(
        baseParams({
          env,
          model: 'kimi2_5',
          fallbackModel: 'qwen',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('failure');
      expect(result.attempts).toHaveLength(4);
      expect(result.error?.type).toBe(ErrorType.RETRY_EXHAUSTED);
      // The fallback event was emitted even though it didn't rescue.
      expect(findSpanEvents('fallback_attempt_start')).toHaveLength(1);
      // Failure with fallback consulted attributes to the LAST model
      // tried. The fallback was consulted last and failed, so the
      // response should attribute the failure to it.
      expect(result.modelUsed).toBe('qwen');
    });

    it('attributes partial_success to primary when primary contributed keys, even if fallback ran', async () => {
      // Primary attempt 1: key 'a' succeeds (kept in successfulCatalog).
      // Primary attempts 2-3: key 'b' keeps failing (placeholder dropped).
      // Fallback attempt: key 'b' STILL fails — placeholder still missing.
      // Result: outcome=partial_success, primary contributed 'a', fallback contributed nothing.
      // modelUsed should attribute to primary (kimi2_5) since it produced the only
      // successful output. See translate-text.ts modelUsed attribution logic.
      const source = JSON.stringify({ a: 'Alpha', b: 'Hello {{name}}' });
      const env = mockEnv(
        aiResponse(JSON.stringify({ a: 'Alfa', b: 'Hola' })), // primary 1: 'a' ok, 'b' fails
        aiResponse(JSON.stringify({ b: 'Hola' })), // primary 2: 'b' fails
        aiResponse(JSON.stringify({ b: 'Hola' })), // primary 3: 'b' fails
        aiResponse(JSON.stringify({ b: 'Hola' })) // fallback: 'b' STILL fails
      );

      const result = await translateText(
        baseParams({
          env,
          text: source,
          model: 'kimi2_5',
          fallbackModel: 'qwen',
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('partial_success');
      expect(result.translation).toEqual({ a: 'Alfa' });
      // Primary contributed; attribution stays with primary even though
      // fallback was consulted. Per-attempt detail lives in Braintrust.
      expect(result.modelUsed).toBe('kimi2_5');
    });

    it('attributes failure to primary when fallback was not eligible', async () => {
      // No fallback configured (fallbackModel omitted/null), primary exhausts.
      // modelUsed should be the primary since it's the only model consulted.
      const env = mockEnv(aiResponse(null), aiResponse(null), aiResponse(null));

      const result = await translateText(
        baseParams({
          env,
          model: 'kimi2_5',
          // fallbackModel omitted → null
          maxAttempts: 3
        })
      );

      expect(result.outcome).toBe('failure');
      expect(result.modelUsed).toBe('kimi2_5');
    });
  });
});
