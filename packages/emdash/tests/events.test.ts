import { emptyTokenUsage, PermanentProviderError } from "@cloudflare/polystella-core";
import type { LogAccess } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranslationUsage } from "../src/contracts.js";
import { setPolystellaEventSink, type PolystellaEvent } from "../src/index.js";
import { emitPolystellaEvent, providerCallErrorKind, providerCallListener } from "../src/server/events.js";

const event: PolystellaEvent = {
  type: "batch_result",
  v: 1,
  jobId: "job-1",
  collection: "posts",
  entryId: "entry-1",
  locale: "fr-FR",
  outcome: "created",
};

function log() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies LogAccess;
}

function named(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

afterEach(() => setPolystellaEventSink(undefined));

describe("emitPolystellaEvent", () => {
  it("logs every event and sends it to the sink once one is set", () => {
    const logger = log();
    const sink = vi.fn();
    emitPolystellaEvent(event, logger);
    setPolystellaEventSink(sink);
    emitPolystellaEvent(event, logger);
    setPolystellaEventSink(undefined);
    emitPolystellaEvent(event, logger);

    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith("polystella.batch_result", event);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("keeps a throwing or rejecting sink from reaching the caller", async () => {
    const logger = log();
    setPolystellaEventSink(() => {
      throw new Error("sync");
    });
    expect(() => emitPolystellaEvent(event, logger)).not.toThrow();
    setPolystellaEventSink(async () => {
      throw new Error("async");
    });
    emitPolystellaEvent(event, logger);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logger.warn).toHaveBeenCalledWith("PolyStella event sink failed", { type: "batch_result", error: "sync" });
    expect(logger.warn).toHaveBeenCalledWith("PolyStella event sink failed", { type: "batch_result", error: "async" });
  });
});

describe("providerCallErrorKind", () => {
  it.each([
    [{ error: new PermanentProviderError("bad key") }, "permanent_provider"],
    [{ error: named("AbortError") }, "aborted"],
    [{ error: named("ProviderTimeoutError") }, "timeout"],
    [{ error: named("AiError", "3046: Request timeout") }, "timeout"],
    [{ error: named("AiError", "5000: other") }, "provider"],
    [{ error: new Error("x"), response: "partial", providerResponse: { finishReason: "length" } }, "truncated"],
    [{ error: new Error("[polystella] model ran out of output tokens in batch 1") }, "truncated"],
    [{ error: new Error("[polystella] no segment markers in the model response."), response: "hi" }, "invalid_response"],
    [{ error: new Error("[polystella] unexpected Anthropic response shape: no text content block") }, "invalid_response"],
    [{ error: new Error("network") }, "provider"],
  ] as const)("classifies %o as %s", (attempt, kind) => {
    expect(providerCallErrorKind(attempt)).toBe(kind);
  });
});

describe("providerCallListener cost", () => {
  const price = { inputPerMillion: 1, outputPerMillion: 4, cachedInputPerMillion: 0.5 };
  const attempt = (providerResponse?: Record<string, number | string>, error?: Error) => ({
    modelId: "m",
    durationMs: 12.4,
    segments: [{ id: "a", text: "x" }],
    ...(providerResponse === undefined ? {} : { providerResponse }),
    ...(error === undefined ? {} : { error }),
  });

  function emitted(
    price: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number } | undefined,
    reply?: Record<string, number | string>,
    error?: Error,
  ) {
    const sink = vi.fn();
    setPolystellaEventSink(sink);
    providerCallListener(log(), { surface: "content", locale: "fr-FR", price }, undefined)(attempt(reply, error) as never);
    return sink.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  it("adds cachedInputTokens and a list-price estimatedCostUsd", () => {
    const call = emitted(price, { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 500_000 });
    expect(call).toMatchObject({ type: "provider_call", inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 500_000 });
    expect(call.estimatedCostUsd).toBeCloseTo(0.4 + 0.3 + 2);
  });

  it("prices failed attempts that still reported tokens", () => {
    const call = emitted(price, { inputTokens: 1_000_000, outputTokens: 0 }, new Error("x"));
    expect(call).toMatchObject({ ok: false, estimatedCostUsd: 1 });
    expect(call).not.toHaveProperty("cachedInputTokens");
  });

  it.each([
    ["no price", undefined, { inputTokens: 1, outputTokens: 1 }],
    ["no reply", price, undefined],
    ["no input tokens", price, { outputTokens: 1 }],
    ["no output tokens", price, { inputTokens: 1 }],
  ])("omits estimatedCostUsd with %s", (_name, modelPrice, reply) => {
    expect(emitted(modelPrice, reply)).not.toHaveProperty("estimatedCostUsd");
  });

  it("emits estimatedCostUsd 0 for a free model", () => {
    expect(emitted({ inputPerMillion: 0, outputPerMillion: 0 }, { inputTokens: 5, outputTokens: 5 })).toMatchObject({
      estimatedCostUsd: 0,
    });
  });
});

describe("providerCallListener usage accumulator", () => {
  const price = { inputPerMillion: 1, outputPerMillion: 4 };
  const call = (reply?: Record<string, number>, error?: Error) =>
    ({
      modelId: "m",
      durationMs: 1,
      segments: [{ id: "a", text: "x" }],
      ...(reply === undefined ? {} : { providerResponse: reply }),
      ...(error === undefined ? {} : { error }),
    }) as never;

  it("counts every attempt once, retries and calls without tokens included, and sums their cost", () => {
    const usage = emptyTokenUsage() as TranslationUsage;
    const listener = providerCallListener(log(), { surface: "batch", locale: "fr-FR", price, usage });
    listener(
      call({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 250_000, reasoningTokens: 5 }, new Error("retry me")),
    );
    listener(call({ inputTokens: 1_000_000, outputTokens: 0 }));
    listener(call(undefined, new Error("no reply")));

    expect(usage).toMatchObject({
      calls: 3,
      inputTokens: 2_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 250_000,
      reasoningTokens: 5,
      unreportedCalls: 1,
    });
    expect(usage.estimatedCostUsd).toBeCloseTo(1 + 1 + 1);
  });

  it("leaves the cost out when there is no price, and when no call reported tokens", () => {
    const unpriced = emptyTokenUsage() as TranslationUsage;
    providerCallListener(log(), { surface: "batch", locale: "fr-FR", usage: unpriced })(call({ inputTokens: 3, outputTokens: 2 }));
    expect(unpriced).toMatchObject({ calls: 1, inputTokens: 3, outputTokens: 2 });
    expect(unpriced).not.toHaveProperty("estimatedCostUsd");

    const silent = emptyTokenUsage() as TranslationUsage;
    providerCallListener(log(), { surface: "batch", locale: "fr-FR", price, usage: silent })(call());
    expect(silent).toMatchObject({ calls: 1, unreportedCalls: 1 });
    expect(silent).not.toHaveProperty("estimatedCostUsd");
  });

  it("still calls the debug listener first and emits the event", () => {
    const order: string[] = [];
    const sink = vi.fn(() => {
      order.push("event");
    });
    setPolystellaEventSink(sink);
    providerCallListener(log(), { surface: "batch", locale: "fr-FR", usage: emptyTokenUsage() }, () => order.push("debug"))(call());
    expect(order).toEqual(["debug", "event"]);
  });
});
