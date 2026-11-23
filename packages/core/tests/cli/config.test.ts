import { describe, expect, it } from "vitest";

import { resolveCatalogConfig, resolveLocaleTagsConfig } from "../../src/cli/config.js";

const i18n = { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] };

describe("resolveCatalogConfig", () => {
  it("keeps Workers AI params and per-locale enable_thinking, and rejects what PolyStella can't send", () => {
    const provider = { kind: "workers-ai", accountId: "a", apiToken: "t", model: "m" };
    const params = { m: { reasoning_effort: "low" } };
    const model = { default: { model: "m", enable_thinking: false }, "pt-BR": { model: "m", enable_thinking: true } };
    expect(resolveCatalogConfig({ provider: { ...provider, model, params } }, i18n).provider).toMatchObject({ model, params });
    expect(() => resolveCatalogConfig({ provider: { ...provider, params: { m: { max_tokens: 1 } } } }, i18n)).toThrow(
      'provider.params.m: cannot set "max_tokens"',
    );
    expect(() => resolveCatalogConfig({ provider: { ...provider, model: { default: { model: "m", thinking: false } } } }, i18n)).toThrow(
      "provider.model.default.thinking: is not recognized",
    );
    expect(() =>
      resolveCatalogConfig({ provider: { kind: "anthropic", apiKey: "k", model: { default: { model: "claude" } } } }, i18n),
    ).toThrow("provider.model.default: must be a non-empty model id string");
  });

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

  it("validates localeTags against every locale, including the default", () => {
    const tagged = { defaultLocale: "en", locales: ["en", "jp", "es-la"] };
    expect(resolveCatalogConfig({ localeTags: { jp: "ja", "es-la": "es-419" } }, tagged).localeTags).toEqual({
      jp: "ja",
      "es-la": "es-419",
    });
    expect(() => resolveCatalogConfig({}, tagged)).toThrow(/locale "jp" uses tag "jp"/);
    expect(() => resolveCatalogConfig({ localeTags: { jp: "ja", fr: "fr" } }, tagged)).toThrow(/localeTags key "fr"/);
    expect(() => resolveCatalogConfig({ localeTags: { jp: 1 } }, tagged)).toThrow(/localeTags.jp must be a non-empty string/);
  });

  it("reads localeTags without validating credentials", () => {
    const tagged = { defaultLocale: "en", locales: ["en", "jp"] };
    expect(resolveLocaleTagsConfig({ localeTags: { jp: "ja" }, provider: { kind: "workers-ai" } }, tagged)).toEqual({ jp: "ja" });
    expect(resolveLocaleTagsConfig(undefined, i18n)).toBeUndefined();
  });

  it("rejects invalid relevant options", () => {
    expect(() => resolveCatalogConfig({ concurrency: 0 }, i18n)).toThrow(/concurrency/);
    expect(() => resolveCatalogConfig({}, { ...i18n, locales: ["en-US", "pt-BR", "pt-BR"] })).toThrow(/duplicates/);
  });

  it("accepts HTTP and R2 glossary sources", () => {
    expect(
      resolveCatalogConfig(
        { glossary: { http: { url: "https://example.com/{locale}.yaml", headers: { Authorization: "Bearer test" } } } },
        i18n,
      ).glossary,
    ).toEqual({ http: { url: "https://example.com/{locale}.yaml", headers: { Authorization: "Bearer test" } } });

    expect(
      resolveCatalogConfig(
        {
          glossary: {
            r2: {
              accountId: "account-id",
              bucket: "glossaries",
              key: "{locale}.yaml",
              accessKeyId: "access-key",
              secretAccessKey: "secret-key",
            },
          },
        },
        i18n,
      ).glossary,
    ).toMatchObject({ r2: { bucket: "glossaries", key: "{locale}.yaml" } });
  });

  it("requires exactly one glossary source", () => {
    expect(() =>
      resolveCatalogConfig({ glossary: { file: "./{locale}.yaml", http: { url: "https://example.com/{locale}.yaml" } } }, i18n),
    ).toThrow(/exactly one/);
    expect(() => resolveCatalogConfig({ glossary: { file: "./{locale}.yaml", http: undefined } }, i18n)).not.toThrow();
  });

  it("reads glossary.matchInflections next to the source", () => {
    expect(resolveCatalogConfig({ glossary: { file: "./{locale}.yaml", matchInflections: true } }, i18n).glossary).toEqual({
      file: "./{locale}.yaml",
      matchInflections: true,
    });
    expect(() => resolveCatalogConfig({ glossary: { file: "./{locale}.yaml", matchInflections: "yes" } }, i18n)).toThrow(
      /glossary\.matchInflections/,
    );
  });
});
