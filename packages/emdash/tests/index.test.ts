import { describe, expect, it } from "vitest";

import { createPlugin, polystellaEmdash, validatePolystellaEmdashOptions, type PolystellaEmdashOptions } from "../src/index.js";

function validOptions(): PolystellaEmdashOptions {
  return {
    provider: { kind: "workers-ai-binding", binding: "AI" },
    catalogs: {
      defaultLocale: "en-US",
      locales: {
        "en-US": { dictionary: { greeting: "Hello" }, filePath: "src/i18n/en-US.json" },
        "ja-JP": { dictionary: { greeting: "Hello" }, filePath: "src/i18n/ja-JP.json" },
      },
    },
    models: { allowed: ["model-a", "model-b"], defaults: { default: "model-a", "ja-JP": "model-b" } },
    glossaryDefaults: {
      "ja-JP": {
        version: "1",
        doNotTranslate: ["Cloudflare"],
        preferredTranslations: {},
        styleRules: [],
        notes: "Use concise Japanese.",
      },
    },
    rules: ["Keep product names unchanged."],
  };
}

describe("polystellaEmdash", () => {
  it("keeps descriptor and runtime declarations aligned", () => {
    const options = validOptions();
    const descriptor = polystellaEmdash(options);
    const runtimeOptions = descriptor.options;
    if (runtimeOptions === undefined) throw new Error("descriptor options are missing");
    const plugin = createPlugin(runtimeOptions);

    expect(descriptor).toMatchObject({
      id: "polystella",
      format: "native",
      entrypoint: "@cloudflare/polystella-emdash",
      adminEntry: "@cloudflare/polystella-emdash/admin",
      adminPages: [{ path: "/", label: "PolyStella" }],
      capabilities: ["content:read"],
      storage: { catalog_overrides: { indexes: ["locale"] } },
    });
    expect(plugin.id).toBe(descriptor.id);
    expect(plugin.version).toBe(descriptor.version);
    expect(plugin.storage).toEqual(descriptor.storage);
    expect(Object.keys(plugin.routes)).toEqual([
      "settings/collections",
      "settings/translation",
      "policy",
      "translate-content",
      "catalog",
      "catalog/generate",
      "catalog/overrides",
      "catalog/runtime",
      "catalog/export",
      "translation-sandbox",
      "overrides",
    ]);
    expect(plugin.admin.entry).toBe(descriptor.adminEntry);
    expect(plugin.admin.pages).toEqual(descriptor.adminPages);
    expect(descriptor).not.toHaveProperty("settingsSchema");
    expect(plugin.admin).not.toHaveProperty("settingsSchema");
  });

  it("preserves arbitrary dictionary keys through EmDash's generated module", () => {
    const options = validOptions();
    options.catalogs.locales["en-US"] = {
      dictionary: JSON.parse('{"__proto__":"Safe"}') as Record<string, string>,
      filePath: "src/i18n/en-US.json",
    };
    const runtimeOptions = polystellaEmdash(options).options;
    if (runtimeOptions === undefined) throw new Error("descriptor options are missing");

    const generatedOptions = Function(`"use strict"; return (${JSON.stringify(runtimeOptions)});`)() as {
      serialized: string;
    };
    const decoded = JSON.parse(generatedOptions.serialized) as PolystellaEmdashOptions;

    expect(Object.hasOwn(decoded.catalogs.locales["en-US"]?.dictionary ?? {}, "__proto__")).toBe(true);
    expect(() => createPlugin(generatedOptions)).not.toThrow();
  });

  it("accepts and preserves nested catalog dictionaries", () => {
    const options = validOptions();
    options.catalogs.locales["en-US"] = {
      dictionary: { nav: { i18n_group_title: "Navigation", home: "Home" } },
      filePath: "src/i18n/en-US.json",
    };
    const runtimeOptions = polystellaEmdash(options).options;
    if (runtimeOptions === undefined) throw new Error("descriptor options are missing");

    const decoded = JSON.parse(runtimeOptions.serialized) as PolystellaEmdashOptions;
    expect(decoded.catalogs.locales["en-US"]?.dictionary).toEqual({
      nav: { i18n_group_title: "Navigation", home: "Home" },
    });
    expect(() => createPlugin(runtimeOptions)).not.toThrow();
  });

  it.each([
    ["binding", { ...validOptions(), provider: { kind: "workers-ai-binding", binding: "not-valid!" } }],
    ["removed collections option", { ...validOptions(), collections: {} }],
    [
      "reserved UI model",
      { ...validOptions(), models: { allowed: ["__polystella_code_default__"], defaults: "__polystella_code_default__" } },
    ],
    ["default model", { ...validOptions(), models: { allowed: ["model-a"], defaults: "model-b" } }],
    ["model locale", { ...validOptions(), models: { allowed: ["model-a"], defaults: { default: "model-a", "fr-FR": "model-a" } } }],
    ["glossary locale", { ...validOptions(), glossaryDefaults: { "fr-FR": validOptions().glossaryDefaults?.["ja-JP"] } }],
    ["default locale", { ...validOptions(), catalogs: { defaultLocale: "fr-FR", locales: validOptions().catalogs.locales } }],
    [
      "repository path",
      {
        ...validOptions(),
        catalogs: {
          defaultLocale: "en-US",
          locales: { "en-US": { dictionary: {}, filePath: "../en-US.json" } },
        },
      },
    ],
    [
      "dictionary value",
      {
        ...validOptions(),
        catalogs: {
          defaultLocale: "en-US",
          locales: { "en-US": { dictionary: { greeting: 1 }, filePath: "src/i18n/en-US.json" } },
        },
      },
    ],
  ])("rejects invalid %s configuration", (_name, options) => {
    expect(() => validatePolystellaEmdashOptions(options)).toThrow("[polystella-emdash]");
  });

  it("supports runtime HTTP credential names without serializing credential values", () => {
    const configured: PolystellaEmdashOptions = {
      ...validOptions(),
      provider: {
        kind: "workers-ai-http",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
      },
    };
    const descriptor = polystellaEmdash(configured);
    const serialized = descriptor.options?.serialized ?? "";

    expect(serialized).toContain("CLOUDFLARE_WORKERS_AI_TOKEN");
    expect(serialized).not.toContain("fake-token");
    expect(JSON.stringify(descriptor)).not.toContain('apiToken":"secret');
  });

  it("rejects unknown provider properties instead of serializing them", () => {
    const configured = {
      ...validOptions(),
      provider: {
        kind: "workers-ai-http",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
        apiToken: "secret-token",
      },
    } as unknown as PolystellaEmdashOptions;

    expect(() => polystellaEmdash(configured)).toThrow("options.provider.apiToken is not supported");
  });
});
