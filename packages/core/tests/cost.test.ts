import { describe, expect, it, vi } from "vitest";

import {
  addTokenUsage,
  createModelPriceLookup,
  emptyTokenUsage,
  estimateCostUsd,
  formatUsageSummary,
  modelPriceProblem,
  summarizeUsage,
  usageFor,
  type ModelPrice,
  type TokenUsage,
} from "../src/index.js";

const PRICE: ModelPrice = { inputPerMillion: 1, outputPerMillion: 4 };

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { ...emptyTokenUsage(), calls: 1, ...overrides };
}

describe("addTokenUsage", () => {
  it("sums reported calls and clamps cached tokens to the input", () => {
    const total = emptyTokenUsage();
    addTokenUsage(total, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningTokens: 3 });
    addTokenUsage(total, { inputTokens: 50, cachedInputTokens: 90, outputTokens: 5 });
    expect(total).toEqual({ calls: 2, inputTokens: 150, cachedInputTokens: 90, outputTokens: 15, reasoningTokens: 3, unreportedCalls: 0 });
  });

  it("counts calls with a missing reply, input or output as unreported and adds no tokens", () => {
    const total = emptyTokenUsage();
    addTokenUsage(total, undefined);
    addTokenUsage(total, { outputTokens: 5 });
    addTokenUsage(total, { inputTokens: 5 });
    expect(total).toEqual({ ...emptyTokenUsage(), calls: 3, unreportedCalls: 3 });
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output per million tokens", () => {
    expect(estimateCostUsd({ inputTokens: 2_000_000, cachedInputTokens: 0, outputTokens: 500_000 }, PRICE)).toBe(4);
  });

  it("bills cached tokens at the cached rate, defaulting to the input rate", () => {
    const tokens = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 0 };
    expect(estimateCostUsd(tokens, { ...PRICE, cachedInputPerMillion: 0.1 })).toBeCloseTo(0.6 + 0.04);
    expect(estimateCostUsd(tokens, PRICE)).toBe(1);
  });

  it("never bills more cached tokens than input tokens", () => {
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 0 }, { ...PRICE, cachedInputPerMillion: 0.5 }),
    ).toBe(0.5);
  });
});

describe("modelPriceProblem", () => {
  it("accepts a price with or without a cached rate, including free models", () => {
    expect(modelPriceProblem(PRICE)).toBeUndefined();
    expect(modelPriceProblem({ ...PRICE, cachedInputPerMillion: 0 })).toBeUndefined();
    expect(modelPriceProblem({ inputPerMillion: 0, outputPerMillion: 0 })).toBeUndefined();
  });

  it.each([
    [null, "must be an object"],
    [[], "must be an object"],
    ["1", "must be an object"],
    [{ ...PRICE, extra: 1 }, 'has unknown key "extra"'],
    [{ outputPerMillion: 1 }, "inputPerMillion must be a number of USD, 0 or more"],
    [{ inputPerMillion: 1 }, "outputPerMillion must be a number of USD, 0 or more"],
    [{ inputPerMillion: -1, outputPerMillion: 1 }, "inputPerMillion must be a number of USD, 0 or more"],
    [{ inputPerMillion: Number.NaN, outputPerMillion: 1 }, "inputPerMillion must be a number of USD, 0 or more"],
    [{ inputPerMillion: "1", outputPerMillion: 1 }, "inputPerMillion must be a number of USD, 0 or more"],
    [{ ...PRICE, cachedInputPerMillion: -0.1 }, "cachedInputPerMillion must be a number of USD, 0 or more"],
  ])("rejects %j", (value, problem) => {
    expect(modelPriceProblem(value)).toBe(problem);
  });
});

describe("createModelPriceLookup", () => {
  it("prefers the prices override and never calls the fallback for it", async () => {
    const fallback = vi.fn(async () => ({ inputPerMillion: 9, outputPerMillion: 9 }));
    const lookup = createModelPriceLookup({ prices: { a: PRICE }, fallback });
    await expect(lookup("a")).resolves.toBe(PRICE);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("resolves undefined without a fallback", async () => {
    await expect(createModelPriceLookup({ prices: { a: PRICE } })("b")).resolves.toBeUndefined();
  });

  it("memoises the fallback per model, sharing a pending lookup", async () => {
    const fallback = vi.fn(async (_modelId: string) => PRICE);
    const lookup = createModelPriceLookup({ fallback });
    await Promise.all([lookup("a"), lookup("a")]);
    await lookup("a");
    await lookup("b");
    expect(fallback.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("memoises a model the fallback does not know", async () => {
    const fallback = vi.fn(async () => undefined);
    const lookup = createModelPriceLookup({ fallback });
    await lookup("a");
    await lookup("a");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("remembers a failed fallback for the life of the lookup: undefined, one onError per model, no retry", async () => {
    const failure = new Error("catalog down");
    const fallback = vi.fn(async (_modelId: string): Promise<ModelPrice | undefined> => Promise.reject(failure));
    const onError = vi.fn();
    const lookup = createModelPriceLookup({ fallback, onError });
    await expect(Promise.all([lookup("a"), lookup("a")])).resolves.toEqual([undefined, undefined]);
    await expect(lookup("a")).resolves.toBeUndefined();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("a", failure);

    await expect(lookup("b")).resolves.toBeUndefined();
    await lookup("b");
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("does not throw on a failed fallback when no onError is given", async () => {
    await expect(createModelPriceLookup({ fallback: async () => Promise.reject(new Error("x")) })("a")).resolves.toBeUndefined();
  });
});

describe("summarizeUsage", () => {
  it("sums usage over models and costs only priced ones", async () => {
    const byModel = new Map([
      ["priced", usage({ calls: 2, inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 })],
      ["free", usage({ inputTokens: 1_000_000, outputTokens: 0 })],
      ["unknown", usage({ inputTokens: 10, outputTokens: 10 })],
    ]);
    const lookup = createModelPriceLookup({ prices: { priced: PRICE, free: { inputPerMillion: 0, outputPerMillion: 0 } } });
    const summary = await summarizeUsage(byModel, lookup);
    expect(summary.estimatedCostUsd).toBe(5);
    expect(summary.unpricedModels).toEqual(["unknown"]);
    expect(summary.usage).toMatchObject({ calls: 4, inputTokens: 2_000_010, outputTokens: 1_000_010 });
  });

  it("leaves cost undefined when no model has a price", async () => {
    const summary = await summarizeUsage(new Map([["m", usage({ inputTokens: 1, outputTokens: 1 })]]), createModelPriceLookup({}));
    expect(summary).toMatchObject({ estimatedCostUsd: undefined, unpricedModels: ["m"] });
  });

  it("skips pricing for models whose calls all went unreported", async () => {
    const lookup = vi.fn(async () => PRICE);
    const summary = await summarizeUsage(new Map([["m", usage({ unreportedCalls: 1 })]]), lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ estimatedCostUsd: undefined, unpricedModels: [] });
    expect(summary.usage.unreportedCalls).toBe(1);
  });
});

describe("formatUsageSummary", () => {
  it("formats counts, cost, unpriced models and unreported calls", () => {
    const line = formatUsageSummary({
      usage: { ...emptyTokenUsage(), calls: 12, inputTokens: 34_000, outputTokens: 5_600, unreportedCalls: 2 },
      estimatedCostUsd: 0.01234,
      unpricedModels: ["a", "b"],
    });
    expect(line).toBe(
      "12 model calls, 34,000 input / 5,600 output tokens, estimated cost $0.0123 (tokens × list price), no price for a, b (left out of the estimate), 2 without token counts",
    );
  });

  it("uses the singular and omits empty parts", () => {
    expect(formatUsageSummary({ usage: { ...emptyTokenUsage(), calls: 1 }, estimatedCostUsd: undefined, unpricedModels: [] })).toBe(
      "1 model call, 0 input / 0 output tokens",
    );
  });
});

describe("usageFor", () => {
  it("adds an empty usage on first use and returns the same one after", () => {
    const byModel = new Map<string, TokenUsage>();
    const first = usageFor(byModel, "m");
    first.calls = 3;
    expect(usageFor(byModel, "m")).toBe(first);
    expect(byModel.size).toBe(1);
  });
});
