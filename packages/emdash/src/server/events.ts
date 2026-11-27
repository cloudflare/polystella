import { estimateCostUsd, isPermanentProviderError, type ModelPrice, type TranslateBatchAttemptEvent } from "@cloudflare/polystella-core";
import type { LogAccess } from "emdash";

import type { BatchJobOutcome } from "../contracts.js";
import type { BatchMessage } from "./batch.js";

/** Where a translation ran: the editor, the catalog page, the sandbox, or a server batch job. */
export type PolystellaEventSurface = "content" | "catalog" | "sandbox" | "batch";

export type ProviderCallErrorKind = "permanent_provider" | "timeout" | "aborted" | "truncated" | "invalid_response" | "provider";

/** One model request, retries included. Carries no prompts, source text, or model output. */
export interface ProviderCallEvent {
  type: "provider_call";
  v: 1;
  surface: PolystellaEventSurface;
  locale: string;
  model: string;
  /** The provider replied and the reply parsed; later checks, such as placeholder validation, can still reject it. */
  ok: boolean;
  errorKind?: ProviderCallErrorKind | undefined;
  durationMs: number;
  segmentCount: number;
  finishReason?: string | undefined;
  /** All input tokens, cached ones included. */
  inputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  /** All output tokens, reasoning included. */
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  /** List-price estimate in USD from the token counts; absent when they or the model's price are unknown. Not an invoice. */
  estimatedCostUsd?: number | undefined;
  /** Batch jobs only. */
  jobId?: string | undefined;
}

/** One batch result write: the translation's real outcome, not the queue acknowledgement. The last write per row wins. */
export interface BatchResultEvent {
  type: "batch_result";
  v: 1;
  jobId: string;
  collection: string;
  entryId: string;
  locale: string;
  outcome: BatchJobOutcome;
}

export type PolystellaEvent = ProviderCallEvent | BatchResultEvent;

export type PolystellaEventSink = (event: PolystellaEvent) => void | Promise<void>;

// On `globalThis` so the Worker entry and the bundled plugin share one sink even if the package is loaded twice.
const sinkHolder: typeof globalThis & { __polystellaEventSink?: PolystellaEventSink | undefined } = globalThis;

/**
 * Sends every PolyStella event to `sink`, such as a Workers Analytics Engine writer. Call it once at Worker
 * module scope; `undefined` removes it. The sink is not awaited, and its errors never affect a translation.
 */
export function setPolystellaEventSink(sink: PolystellaEventSink | undefined): void {
  sinkHolder.__polystellaEventSink = sink;
}

export function emitPolystellaEvent(event: PolystellaEvent, log: LogAccess): void {
  log.info(`polystella.${event.type}`, event);
  const sink = sinkHolder.__polystellaEventSink;
  if (sink === undefined) return;
  const warn = (error: unknown) =>
    log.warn("PolyStella event sink failed", { type: event.type, error: error instanceof Error ? error.message : String(error) });
  try {
    Promise.resolve(sink(event)).catch(warn);
  } catch (error) {
    warn(error);
  }
}

export function emitBatchResult(log: LogAccess, message: BatchMessage, collection: string, outcome: BatchJobOutcome): void {
  const { jobId, entryId, locale } = message;
  emitPolystellaEvent({ type: "batch_result", v: 1, jobId, collection, entryId, locale, outcome }, log);
}

/** An `onBatchAttempt` listener that calls `next` (the debug collector) first, then emits `provider_call`. */
export function providerCallListener(
  log: LogAccess,
  context: { surface: PolystellaEventSurface; locale: string; jobId?: string | undefined; price?: ModelPrice | undefined },
  next?: ((event: TranslateBatchAttemptEvent) => void) | undefined,
): (event: TranslateBatchAttemptEvent) => void {
  return (attempt) => {
    next?.(attempt);
    const ok = attempt.error === undefined;
    const reply = attempt.providerResponse;
    const estimatedCostUsd =
      context.price === undefined || reply?.inputTokens === undefined || reply.outputTokens === undefined
        ? undefined
        : estimateCostUsd(
            { inputTokens: reply.inputTokens, cachedInputTokens: reply.cachedInputTokens ?? 0, outputTokens: reply.outputTokens },
            context.price,
          );
    emitPolystellaEvent(
      {
        type: "provider_call",
        v: 1,
        surface: context.surface,
        locale: context.locale,
        model: attempt.modelId,
        ok,
        ...(ok ? {} : { errorKind: providerCallErrorKind(attempt) }),
        durationMs: Math.round(attempt.durationMs),
        segmentCount: attempt.segments.length,
        ...(reply?.finishReason === undefined ? {} : { finishReason: reply.finishReason }),
        ...(reply?.inputTokens === undefined ? {} : { inputTokens: reply.inputTokens }),
        ...(reply?.cachedInputTokens === undefined ? {} : { cachedInputTokens: reply.cachedInputTokens }),
        ...(reply?.outputTokens === undefined ? {} : { outputTokens: reply.outputTokens }),
        ...(reply?.reasoningTokens === undefined ? {} : { reasoningTokens: reply.reasoningTokens }),
        ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
      },
      log,
    );
  };
}

export function providerCallErrorKind(
  attempt: Pick<TranslateBatchAttemptEvent, "error" | "response" | "providerResponse">,
): ProviderCallErrorKind {
  const { error } = attempt;
  if (isPermanentProviderError(error)) return "permanent_provider";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "AbortError") return "aborted";
  // Workers AI reports its own timeout only as a "3046:" message prefix.
  if (name === "ProviderTimeoutError" || (name === "AiError" && message.startsWith("3046:"))) return "timeout";
  if (attempt.providerResponse?.finishReason === "length" || message.startsWith("[polystella] model ran out of output tokens")) {
    return "truncated";
  }
  // Providers throw "unexpected … response shape" before a reply text exists.
  if (attempt.response !== undefined || message.startsWith("[polystella] unexpected ")) return "invalid_response";
  return "provider";
}
