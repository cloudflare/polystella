import { describe, expect, it } from "vitest";

import { resolveCatalogConfig, resolveCatalogOptions, resolveLocaleTagsConfig } from "../../src/cli/config.js";

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

  it("parses provider.prices for both providers and rejects invalid ones", () => {
    const prices = { "@cf/model": { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 0.5 } };
    const workers = { kind: "workers-ai", accountId: "a", apiToken: "t", model: "@cf/model", prices };
    expect(resolveCatalogConfig({ provider: workers }, i18n).provider).toMatchObject({ prices });
    expect(resolveCatalogConfig({ provider: { kind: "anthropic", apiKey: "k", model: "claude", prices } }, i18n).provider).toMatchObject({
      prices,
    });
    expect(resolveCatalogConfig({ provider: { ...workers, prices: undefined } }, i18n).provider).not.toHaveProperty("prices");

    const withPrices = (value: unknown) => () => resolveCatalogConfig({ provider: { ...workers, prices: value } }, i18n);
    expect(withPrices([])).toThrow(/provider\.prices/);
    expect(withPrices({ m: { inputPerMillion: 1 } })).toThrow(/provider\.prices\.m.*outputPerMillion/);
    expect(withPrices({ m: { inputPerMillion: -1, outputPerMillion: 1 } })).toThrow(/provider\.prices\.m.*inputPerMillion/);
    expect(withPrices({ m: { inputPerMillion: 1, outputPerMillion: 1, extra: 1 } })).toThrow(/unknown key "extra"/);
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

describe("resolveCatalogOptions", () => {
  it("compiles catalog.ignoreKeys and defaults to none", () => {
    expect(resolveCatalogOptions(undefined)).toEqual({ ignoreKeys: [], messageSyntax: "polystella" });
    expect(resolveCatalogOptions({ provider: "unrelated" })).toEqual({ ignoreKeys: [], messageSyntax: "polystella" });
    const resolved = resolveCatalogOptions({ catalog: { ignoreKeys: ["\\$schema"] } });
    expect(resolved.ignoreKeys).toEqual(["\\$schema"]);
    expect(resolved.ignoreKey?.("$schema")).toBe(true);
  });

  it("rejects invalid catalog blocks at config load", () => {
    expect(() => resolveCatalogOptions({ catalog: { ignoreKeys: ["["] } })).toThrow(
      /configuration error:[\s\S]*catalog\.ignoreKeys: contains an invalid regular expression/,
    );
    expect(() => resolveCatalogOptions({ catalog: { ignoreKeys: [/\$schema/] } })).toThrow(/catalog\.ignoreKeys: must be an array/);
    expect(() => resolveCatalogOptions({ catalog: { ignoreKeys: "\\$schema" } })).toThrow(/catalog\.ignoreKeys: must be an array/);
    expect(() => resolveCatalogOptions({ catalog: { ignoreKey: [] } })).toThrow(/catalog\.ignoreKey: is not recognized/);
    expect(() => resolveCatalogOptions({ catalog: [] })).toThrow(/catalog: must be an object/);
  });

  it("reads catalog.messageSyntax, defaulting to polystella", () => {
    expect(resolveCatalogOptions({ catalog: { messageSyntax: "icu" } }).messageSyntax).toBe("icu");
    expect(resolveCatalogOptions({ catalog: {} }).messageSyntax).toBe("polystella");
    expect(() => resolveCatalogOptions({ catalog: { messageSyntax: "inlang" } })).toThrow(
      /catalog\.messageSyntax: must be "polystella" or "icu"/,
    );
  });
});
