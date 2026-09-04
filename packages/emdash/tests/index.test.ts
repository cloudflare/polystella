import { describe, expect, it } from "vitest";

import { createPlugin, polystellaEmdash, validatePolystellaEmdashOptions, type PolystellaEmdashOptions } from "../src/index.js";

function validOptions(): PolystellaEmdashOptions {
  return {
    aiBinding: "AI",
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
    models: { allowed: ["model-a", "model-b"], default: "model-a" },
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
    expect(plugin.admin.settingsSchema?.model).toMatchObject({ type: "select", default: "model-a" });
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
    ["binding", { ...validOptions(), aiBinding: "not-valid!" }],
    ["collection slug", { ...validOptions(), collections: { Posts: validOptions().collections.posts } }],
    ["reserved collection slug", { ...validOptions(), collections: { media: validOptions().collections.posts } }],
    ["field slug", { ...validOptions(), collections: { posts: { sourceLocale: "en-US", fields: ["Title-Field"] } } }],
    ["reserved field slug", { ...validOptions(), collections: { posts: { sourceLocale: "en-US", fields: ["slug"] } } }],
    ["EmDash locale", { ...validOptions(), collections: { posts: { sourceLocale: "en-US-u-ca-gregory", fields: ["title"] } } }],
    ["default model", { ...validOptions(), models: { allowed: ["model-a"], default: "model-b" } }],
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
});
