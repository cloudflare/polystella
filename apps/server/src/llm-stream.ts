import { withTimeout } from './utils';
import type { LLMUsage } from './llm-adapters';

interface CollectLLMStreamParams {
  runPromise: Promise<unknown>;
  totalTimeoutMs: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  locale: string;
}

export interface StreamCollectResult {
  text: string | null;
  usage: LLMUsage;
  chunkCount: number;
  firstTokenMs: number | null;
  totalStreamMs: number;
}

type ParsedChunk = {
  textDelta: string;
  usage: LLMUsage;
  done: boolean;
};

const EMPTY_USAGE: LLMUsage = {
  promptTokens: 0,
  completionTokens: 0
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function usageFromUnknown(value: unknown): LLMUsage {
  const obj = asRecord(value);
  if (!obj) {
    return EMPTY_USAGE;
  }

  const usage = asRecord(obj.usage) ?? asRecord(asRecord(obj.response)?.usage);
  if (!usage) {
    return EMPTY_USAGE;
  }

  return {
    promptTokens:
      (usage.prompt_tokens as number) ??
      (usage.input_tokens as number) ??
      (usage.promptTokens as number) ??
      0,
    completionTokens:
      (usage.completion_tokens as number) ??
      (usage.output_tokens as number) ??
      (usage.completionTokens as number) ??
      0
  };
}

function textDeltaFromObject(value: Record<string, unknown>): string {
  const choices = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const choiceObj = asRecord(choices);
  const deltaContent = asRecord(choiceObj?.delta)?.content;
  const messageContent = asRecord(choiceObj?.message)?.content;

  const directStringPaths = [
    value.response,
    value.content,
    value.delta,
    deltaContent,
    messageContent,
    value.output_text
  ];

  for (const candidate of directStringPaths) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  if (Array.isArray(value.output)) {
    const outputText = value.output
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        const partObj = asRecord(part);
        if (typeof partObj?.text === 'string') return partObj.text;
        if (Array.isArray(partObj?.content)) {
          return (partObj.content as unknown[])
            .map((item: unknown) => {
              const itemObj = asRecord(item);
              return typeof itemObj?.text === 'string' ? itemObj.text : '';
            })
            .join('');
        }
        return '';
      })
      .join('');
    if (outputText) {
      return outputText;
    }
  }

  return '';
}

function parseChunkObject(value: Record<string, unknown>): ParsedChunk {
  const choices = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const doneReason = asRecord(choices)?.finish_reason;
  return {
    textDelta: textDeltaFromObject(value),
    usage: usageFromUnknown(value),
    done: doneReason === 'stop' || doneReason === 'end_turn'
  };
}

function mergeUsage(current: LLMUsage, incoming: LLMUsage): LLMUsage {
  return {
    promptTokens: incoming.promptTokens || current.promptTokens,
    completionTokens: incoming.completionTokens || current.completionTokens
  };
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getReader' in value &&
    typeof (value as ReadableStream<unknown>).getReader === 'function'
  );
}

function readableStreamToAsyncIterator(
  stream: ReadableStream<unknown>
): AsyncIterator<unknown> {
  const reader = stream.getReader();
  return {
    next: async () => {
      const result = await reader.read();
      return result.done
        ? { done: true, value: undefined }
        : { done: false, value: result.value };
    },
    return: async () => {
      try {
        await reader.cancel();
      } catch {
        // no-op
      }
      return { done: true, value: undefined };
    }
  };
}

function hasAsyncIterator(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] ===
      'function'
  );
}

function toAsyncIterator(streamResult: unknown): AsyncIterator<unknown> {
  if (hasAsyncIterator(streamResult)) {
    return streamResult[Symbol.asyncIterator]();
  }

  if (isReadableStream(streamResult)) {
    return readableStreamToAsyncIterator(streamResult);
  }

  const body = asRecord(streamResult)?.body;
  if (isReadableStream(body)) {
    return readableStreamToAsyncIterator(body);
  }

  throw new Error('LLM stream response is not an async iterable stream');
}

function parseNonStreamResult(result: unknown): ParsedChunk {
  if (typeof result === 'string') {
    return { textDelta: result, usage: EMPTY_USAGE, done: true };
  }

  const obj = asRecord(result);
  if (obj) {
    return parseChunkObject(obj);
  }

  return { textDelta: '', usage: EMPTY_USAGE, done: true };
}

function parseSSEPayload(payload: string): ParsedChunk {
  if (!payload || payload === '[DONE]') {
    return { textDelta: '', usage: EMPTY_USAGE, done: payload === '[DONE]' };
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parseChunkObject(parsed);
  } catch {
    return { textDelta: payload, usage: EMPTY_USAGE, done: false };
  }
}

function parseTextChunk(
  textChunk: string,
  sseBuffer: string
): { chunks: ParsedChunk[]; buffer: string; done: boolean } {
  if (textChunk.includes('data:') || sseBuffer.length > 0) {
    let buffer = sseBuffer + textChunk;
    const chunks: ParsedChunk[] = [];
    let done = false;

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (!line || line.startsWith(':')) {
        continue;
      }

      if (line.startsWith('data:')) {
        const payload = line.slice('data:'.length).trim();
        const parsed = parseSSEPayload(payload);
        chunks.push(parsed);
        if (parsed.done) {
          done = true;
          break;
        }
      } else {
        chunks.push({ textDelta: line, usage: EMPTY_USAGE, done: false });
      }
    }

    return { chunks, buffer, done };
  }

  return {
    chunks: [{ textDelta: textChunk, usage: EMPTY_USAGE, done: false }],
    buffer: sseBuffer,
    done: false
  };
}

function decodeChunkText(chunk: unknown, decoder: TextDecoder): string | null {
  if (typeof chunk === 'string') {
    return chunk;
  }

  if (chunk instanceof Uint8Array) {
    return decoder.decode(chunk, { stream: true });
  }

  if (chunk instanceof ArrayBuffer) {
    return decoder.decode(new Uint8Array(chunk), { stream: true });
  }

  return null;
}

/**
 * Kimi (and potentially other models) append a raw completion metadata JSON
 * object directly after the content text in the stream, e.g.:
 *
 *   {"hello":"Hola"}{"id":"chatcmpl-abc123","object":"chat.completion.chunk",...}
 *
 * This function detects the `{"id":"chatcmpl-` boundary, strips everything
 * from that point onward, and extracts usage data from the metadata if
 * parseable.
 */
export function stripCompletionMetadata(
  text: string,
  currentUsage: LLMUsage
): { cleanText: string; usage: LLMUsage } {
  const MARKER = '{"id":"chatcmpl-';
  const index = text.indexOf(MARKER);
  if (index === -1) {
    return { cleanText: text, usage: currentUsage };
  }

  const cleanText = text.slice(0, index);
  const metadataPart = text.slice(index);

  // Try to parse the first JSON object in the metadata to extract usage.
  try {
    let depth = 0;
    let endIndex = -1;
    for (let i = 0; i < metadataPart.length; i++) {
      if (metadataPart[i] === '{') depth++;
      else if (metadataPart[i] === '}') {
        depth--;
        if (depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
    if (endIndex > 0) {
      const parsed = JSON.parse(metadataPart.slice(0, endIndex));
      const extractedUsage = usageFromUnknown(parsed);
      if (extractedUsage.promptTokens || extractedUsage.completionTokens) {
        return { cleanText, usage: mergeUsage(currentUsage, extractedUsage) };
      }
    }
  } catch {
    // Metadata JSON may be truncated; strip it anyway.
  }

  return { cleanText, usage: currentUsage };
}

export async function collectLLMStream(
  params: CollectLLMStreamParams
): Promise<StreamCollectResult> {
  const {
    runPromise,
    totalTimeoutMs,
    firstTokenTimeoutMs,
    idleTimeoutMs,
    locale
  } = params;
  const startedAt = Date.now();

  return withTimeout(
    (async () => {
      const streamResult = await runPromise;
      let iterator: AsyncIterator<unknown> | null = null;

      try {
        iterator = toAsyncIterator(streamResult);
      } catch {
        const parsed = parseNonStreamResult(streamResult);
        return {
          text: parsed.textDelta || null,
          usage: parsed.usage,
          chunkCount:
            parsed.textDelta ||
            parsed.usage.promptTokens ||
            parsed.usage.completionTokens
              ? 1
              : 0,
          firstTokenMs: parsed.textDelta ? Date.now() - startedAt : null,
          totalStreamMs: Date.now() - startedAt
        };
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';
      let combinedText = '';
      let usage: LLMUsage = { ...EMPTY_USAGE };
      let chunkCount = 0;
      let firstTokenMs: number | null = null;
      let doneFromPayload = false;

      while (true) {
        const perReadTimeoutMs =
          firstTokenMs === null ? firstTokenTimeoutMs : idleTimeoutMs;

        const nextChunk = await withTimeout(
          iterator.next(),
          perReadTimeoutMs,
          firstTokenMs === null
            ? `Streaming first token timed out after ${perReadTimeoutMs}ms for locale [${locale}]`
            : `Streaming idle timeout after ${perReadTimeoutMs}ms for locale [${locale}]`
        );

        if (nextChunk.done) {
          break;
        }

        chunkCount += 1;
        const value = nextChunk.value;
        const textChunk = decodeChunkText(value, decoder);

        if (textChunk !== null) {
          const parsed = parseTextChunk(textChunk, sseBuffer);
          sseBuffer = parsed.buffer;
          for (const piece of parsed.chunks) {
            usage = mergeUsage(usage, piece.usage);
            if (piece.textDelta) {
              combinedText += piece.textDelta;
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - startedAt;
              }
            }
            if (piece.done) {
              doneFromPayload = true;
              break;
            }
          }
          if (parsed.done || doneFromPayload) {
            break;
          }
          continue;
        }

        const valueObj = asRecord(value);
        if (valueObj) {
          const parsedObject = parseChunkObject(valueObj);
          usage = mergeUsage(usage, parsedObject.usage);
          if (parsedObject.textDelta) {
            combinedText += parsedObject.textDelta;
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - startedAt;
            }
          }
          if (parsedObject.done) {
            doneFromPayload = true;
            break;
          }
          continue;
        }
      }

      if (sseBuffer.trim()) {
        const leftover = parseSSEPayload(
          sseBuffer.trim().replace(/^data:\s*/, '')
        );
        usage = mergeUsage(usage, leftover.usage);
        if (leftover.textDelta) {
          combinedText += leftover.textDelta;
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - startedAt;
          }
        }
      }

      // Kimi streams the final completion metadata JSON directly after the
      // content text without SSE framing or newline separation.  Detect
      // and strip it so the downstream consumer sees only the translation.
      if (combinedText) {
        const stripped = stripCompletionMetadata(combinedText, usage);
        combinedText = stripped.cleanText;
        usage = stripped.usage;
      }

      return {
        text: combinedText || null,
        usage,
        chunkCount,
        firstTokenMs,
        totalStreamMs: Date.now() - startedAt
      };
    })(),
    totalTimeoutMs,
    `Streaming call timed out after ${totalTimeoutMs}ms for locale [${locale}]`
  );
}
