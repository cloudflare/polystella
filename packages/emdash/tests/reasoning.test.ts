import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PolystellaEmdashOptions } from "../src/index.js";
import { clearReasoningCapabilities, modelPrice, parseCapability, reasoningCapability } from "../src/server/reasoning.js";
import type { PluginRouteDependencies } from "../src/server/routes/provider.js";

const entry = (name: string, value?: unknown) => ({
  name,
  properties: value === undefined ? [] : [{ property_id: "reasoning_effort", value }],
});

const glm = entry("glm", { supported_efforts: ["max", "high", "none"], mandatory: false });
const flash = entry("flash", { mandatory: false, default_enabled: true });
const gptOss = entry("oss", { supported_efforts: ["low", "medium", "high"], mandatory: true });
const kimi = entry("kimi", { mandatory: true });
const plain = entry("plain");

const bindingOptions = (extra: Partial<PolystellaEmdashOptions["models"]> = {}): PolystellaEmdashOptions => ({
  provider: { kind: "workers-ai-binding", binding: "AI" },
  catalogs: { defaultLocale: "en-US", locales: { "en-US": { dictionary: {}, filePath: "en-US.json" } } },
  models: { allowed: ["glm", "flash", "oss", "kimi", "plain"], defaults: "glm", ...extra },
});

const httpOptions = (): PolystellaEmdashOptions => ({
  ...bindingOptions(),
  provider: { kind: "workers-ai-http", accountIdEnv: "ACCOUNT", apiTokenEnv: "TOKEN" },
});

const dependencies: PluginRouteDependencies = { getEnv: async () => ({}), now: () => new Date(0) };

describe("parseCapability", () => {
  beforeEach(clearReasoningCapabilities);

  it("maps listed efforts to reasoning_effort", () => {
    expect(parseCapability(glm)).toEqual(
      new Map([
        ["max", { reasoning_effort: "max" }],
        ["high", { reasoning_effort: "high" }],
        ["none", { reasoning_effort: "none" }],
      ]),
    );
  });

  it("offers a none/on switch for a model with only an optional flag", () => {
    expect(parseCapability(flash)).toEqual(
      new Map([
        ["none", { enable_thinking: false }],
        ["on", { enable_thinking: true }],
      ]),
    );
  });

  it("never offers none when thinking is mandatory", () => {
    expect([...(parseCapability(gptOss)?.keys() ?? [])]).toEqual(["low", "medium", "high"]);
  });

  it("reads a property value sent as JSON text", () => {
    expect(parseCapability(entry("x", JSON.stringify({ supported_efforts: ["low"], mandatory: true })))?.get("low")).toEqual({
      reasoning_effort: "low",
    });
  });

  it.each([
    ["mandatory without efforts", kimi],
    ["no property", plain],
    ["undefined", undefined],
    ["a non-object", "text"],
    ["a non-object value", entry("x", "high")],
    ["empty efforts", entry("x", { supported_efforts: [] })],
    ["non-string efforts", entry("x", { supported_efforts: [1, ""], mandatory: true })],
  ])("returns null for %s", (_name, value) => {
    expect(parseCapability(value)).toBeNull();
  });
});

describe("reasoningCapability", () => {
  beforeEach(clearReasoningCapabilities);

  it("lets models.reasoningInput override the catalog without calling it", async () => {
    const models = vi.fn();
    const options = bindingOptions({ reasoningInput: { glm: { off: { think: false } } } });
    const capability = await reasoningCapability(options, { AI: { models } }, "glm", dependencies);
    expect(capability).toEqual(new Map([["off", { think: false }]]));
    expect(models).not.toHaveBeenCalled();
  });

  it("reads the binding catalog, picks the exact model name, and caches it", async () => {
    const models = vi.fn().mockResolvedValue([entry("glm-other", { mandatory: false }), glm]);
    const env = { AI: { models } };
    const first = await reasoningCapability(bindingOptions(), env, "glm", dependencies);
    expect([...(first?.keys() ?? [])]).toEqual(["max", "high", "none"]);
    await reasoningCapability(bindingOptions(), env, "glm", dependencies);
    expect(models).toHaveBeenCalledOnce();
    expect(models).toHaveBeenCalledWith({ search: "glm" });
  });

  it("returns null when the catalog has no exact match", async () => {
    const env = { AI: { models: async () => [glm] } };
    await expect(reasoningCapability(bindingOptions(), env, "kimi", dependencies)).resolves.toBeNull();
  });

  it("throws when the binding cannot list models or returns a bad list", async () => {
    await expect(reasoningCapability(bindingOptions(), { AI: {} }, "glm", dependencies)).rejects.toThrow("cannot list models");
    clearReasoningCapabilities();
    await expect(reasoningCapability(bindingOptions(), undefined, "glm", dependencies)).rejects.toThrow("cannot list models");
    clearReasoningCapabilities();
    const models = vi.fn().mockResolvedValue("nope");
    await expect(reasoningCapability(bindingOptions(), { AI: { models } }, "glm", dependencies)).rejects.toThrow("unexpected model list");
  });

  it("searches the HTTP catalog with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: [glm] }));
    const capability = await reasoningCapability(httpOptions(), { ACCOUNT: "acct", TOKEN: "secret" }, "glm", {
      ...dependencies,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capability?.has("high")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?search=glm", {
      headers: { Authorization: "Bearer secret" },
      signal: expect.any(AbortSignal),
    });
  });

  it("throws on HTTP catalog failures, remembers them for a minute, then retries", async () => {
    const env = { ACCOUNT: "acct", TOKEN: "secret" };
    await expect(reasoningCapability(httpOptions(), {}, "glm", dependencies)).rejects.toThrow("credentials are unavailable");
    clearReasoningCapabilities();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ nope: true }))
      .mockResolvedValueOnce(Response.json({ result: [glm] }));
    const deps = { ...dependencies, fetchImpl: fetchImpl as unknown as typeof fetch };
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      await expect(reasoningCapability(httpOptions(), env, "glm", deps)).rejects.toThrow("HTTP 500");
      now.mockReturnValue(30_000);
      await expect(reasoningCapability(httpOptions(), env, "glm", deps)).rejects.toThrow("HTTP 500");
      expect(fetchImpl).toHaveBeenCalledOnce();
      now.mockReturnValue(62_000);
      await expect(reasoningCapability(httpOptions(), env, "glm", deps)).rejects.toThrow("unexpected response");
      now.mockReturnValue(130_000);
      await expect(reasoningCapability(httpOptions(), env, "glm", deps)).resolves.not.toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("does not share an unresolved lookup between concurrent calls", async () => {
    const resolvers: Array<(value: unknown[]) => void> = [];
    const models = vi.fn(() => new Promise<unknown[]>((resolve) => resolvers.push(resolve)));
    const env = { AI: { models } };
    const first = reasoningCapability(bindingOptions(), env, "glm", dependencies);
    const second = reasoningCapability(bindingOptions(), env, "glm", dependencies);
    expect(models).toHaveBeenCalledTimes(2);
    for (const resolve of resolvers) resolve([glm]);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("rethrows a cached failure for 60 s, then retries (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const models = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([glm]);
      const env = { AI: { models } };
      await expect(reasoningCapability(bindingOptions(), env, "glm", dependencies)).rejects.toThrow("boom");
      vi.advanceTimersByTime(59_000);
      await expect(reasoningCapability(bindingOptions(), env, "glm", dependencies)).rejects.toThrow("boom");
      expect(models).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2_000);
      await expect(reasoningCapability(bindingOptions(), env, "glm", dependencies)).resolves.not.toBeNull();
      expect(models).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reads the catalog for a custom endpoint", async () => {
    const fetchImpl = vi.fn();
    const options: PolystellaEmdashOptions = {
      ...httpOptions(),
      provider: { kind: "workers-ai-http", accountIdEnv: "ACCOUNT", apiTokenEnv: "TOKEN", endpoint: "https://gateway.example/run" },
    };
    const deps = { ...dependencies, fetchImpl: fetchImpl as unknown as typeof fetch };
    await expect(reasoningCapability(options, { ACCOUNT: "a", TOKEN: "t" }, "glm", deps)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("modelPrice", () => {
  beforeEach(clearReasoningCapabilities);

  const priced = (name: string, input = 0.152, output = 0.5) => ({
    name,
    properties: [
      {
        property_id: "price",
        value: [
          { unit: "per M input tokens", price: input, currency: "USD" },
          { unit: "per M output tokens", price: output, currency: "USD" },
        ],
      },
    ],
  });

  it("prefers models.prices and does not call the catalog", async () => {
    const models = vi.fn();
    const price = { inputPerMillion: 1, outputPerMillion: 2 };
    const options = bindingOptions({ prices: { glm: price } });
    await expect(modelPrice(options, { AI: { models } }, "glm", dependencies)).resolves.toBe(price);
    expect(models).not.toHaveBeenCalled();
  });

  it("reads the exact model's price from the catalog and shares the lookup with the reasoning capability", async () => {
    const models = vi
      .fn()
      .mockResolvedValue([
        priced("glm-other", 9, 9),
        { ...priced("glm"), ...glm, properties: [...glm.properties, ...priced("glm").properties] },
      ]);
    const env = { AI: { models } };
    await expect(modelPrice(bindingOptions(), env, "glm", dependencies)).resolves.toEqual({
      inputPerMillion: 0.152,
      outputPerMillion: 0.5,
    });
    await expect(reasoningCapability(bindingOptions(), env, "glm", dependencies)).resolves.not.toBeNull();
    expect(models).toHaveBeenCalledOnce();
  });

  it("is undefined for an unknown model, an unpriced entry, or a catalog that fails", async () => {
    const env = { AI: { models: async () => [glm] } };
    await expect(modelPrice(bindingOptions(), env, "glm", dependencies)).resolves.toBeUndefined();
    await expect(modelPrice(bindingOptions(), env, "kimi", dependencies)).resolves.toBeUndefined();
    clearReasoningCapabilities();
    await expect(modelPrice(bindingOptions(), { AI: {} }, "glm", dependencies)).resolves.toBeUndefined();
    await expect(modelPrice(httpOptions(), {}, "glm", dependencies)).resolves.toBeUndefined();
  });
});
