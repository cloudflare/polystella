import { describe, it, expect } from 'vitest';
import { collectLLMStream, stripCompletionMetadata } from './llm-stream';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('collectLLMStream', () => {
  it('assembles streamed object deltas into final text', async () => {
    const stream = (async function* () {
      yield { choices: [{ delta: { content: 'Hola ' } }] };
      yield {
        choices: [{ delta: { content: 'mundo' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 }
      };
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('Hola mundo');
    expect(result.usage.promptTokens).toBe(11);
    expect(result.usage.completionTokens).toBe(3);
    expect(result.chunkCount).toBe(2);
    expect(result.firstTokenMs).not.toBeNull();
  });

  it('handles split SSE chunks across boundaries', async () => {
    const stream = (async function* () {
      yield 'data: {"choices":[{"delta":{"content":"Hel"}}';
      yield ']}\n';
      yield 'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n';
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('Hello');
    expect(result.chunkCount).toBe(3);
  });

  it('stops consuming when SSE [DONE] arrives', async () => {
    const stream = (async function* () {
      yield 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n';
      yield 'data: [DONE]\n';
      await sleep(40);
      yield 'data: {"choices":[{"delta":{"content":"-late"}}]}\n';
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 25,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('Hi');
  });

  it('captures usage from final usage-only chunk', async () => {
    const stream = (async function* () {
      yield { choices: [{ delta: { content: 'ok' } }] };
      yield { usage: { input_tokens: 14, output_tokens: 5 } };
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('ok');
    expect(result.usage.promptTokens).toBe(14);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('fails when first token exceeds first-token timeout', async () => {
    const stream = (async function* () {
      await sleep(30);
      yield { choices: [{ delta: { content: 'late' } }] };
    })();

    await expect(
      collectLLMStream({
        runPromise: Promise.resolve(stream),
        totalTimeoutMs: 500,
        firstTokenTimeoutMs: 5,
        idleTimeoutMs: 100,
        locale: 'es-ES'
      })
    ).rejects.toThrow('first token timed out');
  });

  it('fails when stream goes idle after first token', async () => {
    const stream = (async function* () {
      yield { choices: [{ delta: { content: 'ok' } }] };
      await sleep(30);
      yield { choices: [{ delta: { content: 'later' } }] };
    })();

    await expect(
      collectLLMStream({
        runPromise: Promise.resolve(stream),
        totalTimeoutMs: 500,
        firstTokenTimeoutMs: 100,
        idleTimeoutMs: 5,
        locale: 'es-ES'
      })
    ).rejects.toThrow('idle timeout');
  });

  it('strips kimi completion metadata appended to JSON translation', async () => {
    // Real kimi pattern: translation JSON followed immediately by chatcmpl metadata
    const stream = (async function* () {
      yield '{"hello":"¿Cómo estás?"}{"id":"chatcmpl-bd0d3b78506f9517","object":"chat.completion.chunk","created":1775107512,"model":"@cf/moonshotai/kimi-k2.5","choices":[],"usage":{"prompt_tokens":1386,"total_tokens":2692,"completion_tokens":1306},"p":"abdefgh"}\n\ndata: {"response":"","usage":{"prompt_tokens":1386,"completion_tokens":1306,"total_tokens":2692,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]';
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('{"hello":"¿Cómo estás?"}');
    expect(result.usage.promptTokens).toBe(1386);
    expect(result.usage.completionTokens).toBe(1306);
  });

  it('strips kimi completion metadata appended to plain text', async () => {
    const stream = (async function* () {
      yield ' hola{"id":"chatcmpl-bd9d66644083c02e","object":"chat.completion.chunk","created":1775107397,"model":"@cf/moonshotai/kimi-k2.5","choices":[],"usage":{"prompt_tokens":1249,"total_tokens":1480,"completion_tokens":231},"p":"abdefghijklmnoprstuvx"}\n\ndata: {"response":"","usage":{"prompt_tokens":1249,"completion_tokens":231,"total_tokens":1480,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]';
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('hola');
    expect(result.usage.promptTokens).toBe(1249);
    expect(result.usage.completionTokens).toBe(231);
  });

  it('strips kimi metadata even when truncated (no trailing SSE)', async () => {
    // Real kimi pattern where metadata is truncated / no SSE follows
    const stream = (async function* () {
      yield ' {\n  "country_challenge.title": "Desafío por país"\n}{"id":"chatcmpl-bfd4ab0d9cac12a0","object":"chat.completion.chunk","created":1775106702,"model":"@cf/moonshotai/kimi-k2.5","choices":[],"usage":{"prompt_tokens":1599,"total_tokens":4348,"completion_tokens":2749},"p":"abdefghijklmnoprstuvxyz1234567890abdefghijklmnoprs';
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe(
      ' {\n  "country_challenge.title": "Desafío por país"\n}'
    );
  });

  it('leaves text unchanged when no completion metadata is present', async () => {
    const stream = (async function* () {
      yield { choices: [{ delta: { content: '{"key":"valor"}' } }] };
    })();

    const result = await collectLLMStream({
      runPromise: Promise.resolve(stream),
      totalTimeoutMs: 500,
      firstTokenTimeoutMs: 100,
      idleTimeoutMs: 100,
      locale: 'es-ES'
    });

    expect(result.text).toBe('{"key":"valor"}');
  });
});

describe('stripCompletionMetadata', () => {
  const EMPTY = { promptTokens: 0, completionTokens: 0 };

  it('strips metadata and extracts usage from JSON translation output', () => {
    const input =
      '{"hello":"¿Cómo estás?"}{"id":"chatcmpl-abc","object":"chat.completion.chunk","created":0,"model":"kimi","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}';
    const result = stripCompletionMetadata(input, EMPTY);

    expect(result.cleanText).toBe('{"hello":"¿Cómo estás?"}');
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
  });

  it('strips metadata from plain text output', () => {
    const input =
      'Hola mundo{"id":"chatcmpl-xyz","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}';
    const result = stripCompletionMetadata(input, EMPTY);

    expect(result.cleanText).toBe('Hola mundo');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('handles truncated metadata JSON gracefully', () => {
    const input = '{"key":"value"}{"id":"chatcmpl-trunc","object":"chat.comple';
    const result = stripCompletionMetadata(input, EMPTY);

    expect(result.cleanText).toBe('{"key":"value"}');
    // Usage stays at EMPTY since metadata is unparseable
    expect(result.usage).toEqual(EMPTY);
  });

  it('returns text unchanged when no metadata marker is present', () => {
    const input = '{"greeting":"Hola","farewell":"Adiós"}';
    const result = stripCompletionMetadata(input, EMPTY);

    expect(result.cleanText).toBe(input);
    expect(result.usage).toEqual(EMPTY);
  });

  it('preserves existing usage when metadata has none', () => {
    const existing = { promptTokens: 50, completionTokens: 25 };
    const input = 'hello{"id":"chatcmpl-no-usage","choices":[]}';
    const result = stripCompletionMetadata(input, existing);

    expect(result.cleanText).toBe('hello');
    expect(result.usage).toEqual(existing);
  });
});
