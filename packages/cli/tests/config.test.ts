import { describe, expect, it } from "vitest";

import { resolveCatalogConfig } from "../src/config.js";

const i18n = { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] };

describe("resolveCatalogConfig", () => {
  it("applies catalog defaults and ignores unrelated integration options", () => {
    const resolved = resolveCatalogConfig(
      {
        sourceDir: 42,
        r2: "not relevant to catalog commands",
        provider: {
          kind: "workers-ai",
          accountId: "fake-account",
          apiToken: "fake-token",
          model: { default: "model/default", "pt-BR": "model/pt" },
        },
      },
      i18n,
    );

    expect(resolved).toMatchObject({
      defaultLocale: "en-US",
      locales: ["pt-BR"],
      concurrency: 4,
      maxRetries: 2,
      prompt: {},
      provider: { maxTokens: 8192, batchInputTokenBudget: 4000 },
    });
  });

  it("preserves Anthropic and prompt overrides", () => {
    const resolved = resolveCatalogConfig(
      {
        concurrency: 2,
        maxRetries: 0,
        prompt: { context: "Use product terminology." },
        provider: {
          kind: "anthropic",
          apiKey: "fake-key",
          model: "claude-test",
          maxTokens: 2048,
          batchInputTokenBudget: 1000,
        },
      },
      i18n,
    );

    expect(resolved).toMatchObject({
      concurrency: 2,
      maxRetries: 0,
      prompt: { context: "Use product terminology." },
      provider: { kind: "anthropic", model: "claude-test", maxTokens: 2048, batchInputTokenBudget: 1000 },
    });
  });

  it("rejects invalid relevant options", () => {
    expect(() => resolveCatalogConfig({ concurrency: 0 }, i18n)).toThrow(/concurrency/);
    expect(() => resolveCatalogConfig({}, { ...i18n, locales: ["en-US", "pt-BR", "pt-BR"] })).toThrow(/duplicates/);
  });
});
