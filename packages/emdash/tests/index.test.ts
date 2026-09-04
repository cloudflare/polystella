import { describe, expect, it } from "vitest";

import { createPlugin, polystellaEmdash, validatePolystellaEmdashOptions, type PolystellaEmdashOptions } from "../src/index.js";

function validOptions(): PolystellaEmdashOptions {
  return {
    provider: { kind: "workers-ai-binding", binding: "AI" },
    collections: {
      posts: { sourceLocale: "en-US", fields: ["title", "body"] },
    },
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
      adminPages: [
        { path: "/catalog", label: "Catalog" },
        { path: "/settings", label: "Settings" },
      ],
      capabilities: ["content:read"],
      storage: { catalog_overrides: { indexes: ["locale"] } },
    });
    expect(plugin.id).toBe(descriptor.id);
    expect(plugin.version).toBe(descriptor.version);
    expect(plugin.storage).toEqual(descriptor.storage);
    expect(Object.keys(plugin.routes)).toEqual([
      "settings/collections",
      "policy",
      "translate-content",
      "catalog",
      "catalog/generate",
      "catalog/overrides",
      "catalog/runtime",
      "catalog/export",
      "overrides",
    ]);
    expect(plugin.admin.entry).toBe(descriptor.adminEntry);
    expect(plugin.admin.pages).toEqual(descriptor.adminPages);
    expect(plugin.admin.settingsSchema).toEqual(descriptor.settingsSchema);
    expect(plugin.admin.settingsSchema?.["model:ja-JP"]).toMatchObject({
      type: "select",
      default: "__polystella_deployment_default__",
      label: "Translation model (ja-JP)",
    });
    expect(plugin.admin.settingsSchema?.["glossaryMode:ja-JP"]).toMatchObject({ type: "select", default: "default" });
    expect(plugin.admin.settingsSchema?.["glossary:ja-JP"]).toMatchObject({ type: "string", default: "" });
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

  it.each([
    ["binding", { ...validOptions(), provider: { kind: "workers-ai-binding", binding: "not-valid!" } }],
    ["collection slug", { ...validOptions(), collections: { Posts: validOptions().collections.posts } }],
    ["reserved collection slug", { ...validOptions(), collections: { media: validOptions().collections.posts } }],
    ["field slug", { ...validOptions(), collections: { posts: { sourceLocale: "en-US", fields: ["Title-Field"] } } }],
    ["reserved field slug", { ...validOptions(), collections: { posts: { sourceLocale: "en-US", fields: ["slug"] } } }],
    ["EmDash locale", { ...validOptions(), collections: { posts: { sourceLocale: "en-US-u-ca-gregory", fields: ["title"] } } }],
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
    ["duplicate fields", { ...validOptions(), collections: { posts: { sourceLocale: "en-US", fields: ["title", "title"] } } }],
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
    expect(JSON.stringify(descriptor.settingsSchema)).not.toContain("apiToken");
  });
});
