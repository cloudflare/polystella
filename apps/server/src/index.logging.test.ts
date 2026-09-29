import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spanLog, mockTranslateText } = vi.hoisted(() => ({
  spanLog: vi.fn(),
  mockTranslateText: vi.fn()
}));

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

import app, { classifyCallerOrigin } from './index';

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

function makeRequest(body: Record<string, unknown>) {
  return new Request('https://api.example.com/api/translate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      referer: 'http://localhost:5173/',
      'user-agent': 'Mozilla/5.0 Vitest',
      'cf-ray': 'abc123-SJC'
    },
    body: JSON.stringify(body)
  });
}

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

describe('translate endpoint observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs raw request context metadata on success path', async () => {
    mockTranslateText.mockResolvedValue({
      locale: 'pt-BR',
      translation: 'Ola',
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
      modelUsed: 'kimi2_5'
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

    expect(response.status).toBe(200);

    const events = spanLog.mock.calls.map(([event]) => event);
    const inputEvent = events.find((event) => event?.input?.locales);
    const outputEvent = events.find((event) => event?.scores);

    expect(inputEvent).toBeTruthy();
    expect(outputEvent).toBeTruthy();

    expect(inputEvent.metadata.request_origin).toBe('http://localhost:5173');
    expect(inputEvent.metadata.request_referer).toBe('http://localhost:5173/');
    expect(inputEvent.metadata.cf_ray).toBe('abc123-SJC');
    expect(inputEvent.metadata.node_env).toBe(process.env['NODE_ENV'] ?? '');
    // Origin host (localhost) wins over the Vitest UA heuristic since the
    // UA heuristic only fires when there's no Origin signal.
    expect(inputEvent.metadata.caller_origin).toBe('ui-dev');

    expect(outputEvent.metadata.request_origin).toBe('http://localhost:5173');
    expect(outputEvent.metadata.request_referer).toBe('http://localhost:5173/');
    expect(outputEvent.metadata.cf_ray).toBe('abc123-SJC');
    expect(outputEvent.metadata.node_env).toBe(process.env['NODE_ENV'] ?? '');
    expect(outputEvent.metadata.caller_origin).toBe('ui-dev');
    expect(JSON.stringify(events)).not.toContain('Hello world');
    expect(JSON.stringify(events)).not.toContain('Ola');
  });

  it('logs raw request context metadata on token-limit failure path', async () => {
    const response = await app.fetch(
      makeRequest({
        text: 'a '.repeat(20_000),
        targetLocale: 'pt-BR',
        model: 'kimi2_5'
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(400);

    const events = spanLog.mock.calls.map(([event]) => event);
    const tokenLimitEvent = events.find(
      (event) => event?.error?.type === 'token_limit_exceeded'
    );

    expect(tokenLimitEvent).toBeTruthy();
    expect(tokenLimitEvent.metadata.request_origin).toBe(
      'http://localhost:5173'
    );
    expect(tokenLimitEvent.metadata.request_referer).toBe(
      'http://localhost:5173/'
    );
    expect(tokenLimitEvent.metadata.cf_ray).toBe('abc123-SJC');
    expect(tokenLimitEvent.metadata.node_env).toBe(
      process.env['NODE_ENV'] ?? ''
    );
    expect(tokenLimitEvent.metadata.caller_origin).toBe('ui-dev');
    expect(JSON.stringify(tokenLimitEvent)).not.toContain('a a a a a');
  });
});

describe('classifyCallerOrigin', () => {
  const baseInputs = {
    request_origin: '',
    request_referer: '',
    request_source: '',
    ci_job_id: ''
  };

  it('falls back to unknown when no signals present', () => {
    expect(classifyCallerOrigin(baseInputs)).toBe('unknown');
  });

  it('passes x-request-source verbatim (lowercased)', () => {
    expect(
      classifyCallerOrigin({ ...baseInputs, request_source: 'Stratus' })
    ).toBe('stratus');
  });

  it('classifies as ci when x-ci-job-id is present', () => {
    expect(classifyCallerOrigin({ ...baseInputs, ci_job_id: '12345' })).toBe(
      'ci'
    );
  });

  it('x-request-source wins over x-ci-job-id', () => {
    expect(
      classifyCallerOrigin({
        ...baseInputs,
        request_source: 'stratus',
        ci_job_id: '12345'
      })
    ).toBe('stratus');
  });

  it('classifies dev UI from localhost Origin', () => {
    expect(
      classifyCallerOrigin({
        ...baseInputs,
        request_origin: 'http://localhost:5173'
      })
    ).toBe('ui-dev');
  });

  it('classifies dev UI from 127.0.0.1 Origin', () => {
    expect(
      classifyCallerOrigin({
        ...baseInputs,
        request_origin: 'http://127.0.0.1:5173'
      })
    ).toBe('ui-dev');
  });

  it('falls back to Referer host when Origin is empty', () => {
    expect(
      classifyCallerOrigin({
        ...baseInputs,
        request_referer: 'https://example.com/some/path'
      })
    ).toBe('example.com');
  });

  it('returns the host verbatim for an unrecognized Origin host', () => {
    expect(
      classifyCallerOrigin({
        ...baseInputs,
        request_origin: 'https://example.com'
      })
    ).toBe('example.com');
  });
});
