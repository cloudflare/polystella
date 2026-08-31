import { describe, expect, it, vi } from "vitest";

import {
  EMPTY_GLOSSARY,
  isPermanentProviderError,
  PermanentProviderError,
  resolveModelId,
  translateBatch,
  type Segment,
  type Translator,
} from "../src/index.js";

const segments: Segment[] = [
  { id: "fm:title", text: "An apology" },
  { id: "body:0", text: "We regret any inconvenience." },
];

const goodResponse = ["@@fm:title@@", "Um pedido de desculpas", "", "@@body:0@@", "Lamentamos o inconveniente."].join("\n");

const options = (translator: Translator) => ({
  translator,
  segments,
  glossary: EMPTY_GLOSSARY,
  sourceLocale: "en-US",
  targetLocale: "pt-BR",
});

describe("resolveModelId", () => {
  it("resolves strings, locale overrides, and defaults", () => {
    expect(resolveModelId("default-model", "pt-BR")).toBe("default-model");
    const models = { default: "default-model", "ja-JP": "japanese-model" };
    expect(resolveModelId(models, "ja-JP")).toBe("japanese-model");
    expect(resolveModelId(models, "pt-BR")).toBe("default-model");
  });
});

describe("translateBatch", () => {
  it("short-circuits empty input without calling the translator", async () => {
    const translate = vi.fn();
    const result = await translateBatch({ ...options({ modelId: "test", translate }), segments: [] });
    expect(result.size).toBe(0);
    expect(translate).not.toHaveBeenCalled();
  });

  it("builds a prompt, forwards the signal, and parses the response", async () => {
    const controller = new AbortController();
    const translate = vi.fn().mockResolvedValue(goodResponse);
    const result = await translateBatch({ ...options({ modelId: "test", translate }), signal: controller.signal });
    expect(result.get("fm:title")).toBe("Um pedido de desculpas");
    expect(translate).toHaveBeenCalledOnce();
    expect(translate.mock.calls[0]?.[0]).toMatch(/professional translator/);
    expect(translate.mock.calls[0]?.[1]).toMatch(/@@fm:title@@/);
    expect(translate.mock.calls[0]?.[2]).toBe(controller.signal);
  });

  it("retries parse and transient failures and reports only followed retries", async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce("not marker-delimited")
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(goodResponse);
    const onRetry = vi.fn();
    const result = await translateBatch({
      ...options({ modelId: "test", translate }),
      maxRetries: 2,
      onRetry,
    });
    expect(result.size).toBe(2);
    expect(translate).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map(([event]) => [event.attempt, event.totalAttempts])).toEqual([
      [1, 3],
      [2, 3],
    ]);
  });

  it("throws the final error and does not report the final failed attempt as a retry", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockRejectedValueOnce(new Error("final"));
    const onRetry = vi.fn();
    await expect(translateBatch({ ...options({ modelId: "test", translate }), maxRetries: 2, onRetry })).rejects.toThrow("final");
    expect(translate).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("defaults to one attempt", async () => {
    const translate = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(translateBatch(options({ modelId: "test", translate }))).rejects.toThrow("boom");
    expect(translate).toHaveBeenCalledOnce();
  });

  it("short-circuits retries for local and foreign permanent errors", async () => {
    const localTranslate = vi.fn().mockRejectedValue(new PermanentProviderError("local permanent"));
    await expect(translateBatch({ ...options({ modelId: "test", translate: localTranslate }), maxRetries: 3 })).rejects.toThrow(
      "local permanent",
    );
    expect(localTranslate).toHaveBeenCalledOnce();

    const foreignError = Object.assign(new Error("foreign permanent"), { _tag: "PermanentProviderError" as const });
    const foreignTranslate = vi.fn().mockRejectedValue(foreignError);
    expect(isPermanentProviderError(foreignError)).toBe(true);
    await expect(translateBatch({ ...options({ modelId: "test", translate: foreignTranslate }), maxRetries: 3 })).rejects.toThrow(
      "foreign permanent",
    );
    expect(foreignTranslate).toHaveBeenCalledOnce();
  });

  it("honors pre-aborted and between-attempt cancellation", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("cancelled"));
    const neverCalled = vi.fn().mockResolvedValue(goodResponse);
    await expect(translateBatch({ ...options({ modelId: "test", translate: neverCalled }), signal: preAborted.signal })).rejects.toThrow();
    expect(neverCalled).not.toHaveBeenCalled();

    const duringRetry = new AbortController();
    const calledOnce = vi.fn().mockImplementation(async () => {
      duringRetry.abort(new Error("cancelled"));
      throw new Error("transient");
    });
    await expect(
      translateBatch({
        ...options({ modelId: "test", translate: calledOnce }),
        maxRetries: 3,
        signal: duringRetry.signal,
      }),
    ).rejects.toThrow();
    expect(calledOnce).toHaveBeenCalledOnce();
  });
});
