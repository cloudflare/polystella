import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Glossary } from "@cloudflare/polystella-core";
import { hashGlossary } from "@cloudflare/polystella-core/cli/glossary";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CodeGlossaryView } from "../src/admin/plugin-page/CodeDefaultsPage.js";
import { localeCustomization } from "../src/admin/plugin-page/tabs/TranslationSettingsTab/TranslationSettingsTab.js";
import { loadGlossaryDefaults } from "../src/config.js";
import type { TranslationLocaleSettings } from "../src/contracts.js";
import {
  deserializeOptions,
  serializeOptions,
  validatePolystellaEmdashOptions,
  type PolystellaEmdashOptions,
} from "../src/server/options.js";
import { codeGlossaryView } from "../src/server/settings-storage.js";
import { resolveGlossary } from "../src/settings.js";

const glossary: Glossary = {
  version: "v1",
  doNotTranslate: ["Cloudflare", "Workers"],
  preferredTranslations: { dashboard: "Tableau de bord" },
  styleRules: [{ category: "tone", instruction: "Use vous." }],
  notes: "",
};
const yaml = "# kept as written\nversion: v1\ndoNotTranslate:\n  - Cloudflare\n  - Workers\n";

function locale(overrides: Partial<TranslationLocaleSettings> = {}): TranslationLocaleSettings {
  return {
    locale: "fr",
    defaultModel: "@cf/vendor/model-a",
    model: null,
    reasoning: null,
    defaultReasoning: null,
    defaultGlossary: glossary,
    defaultGlossarySource: { format: "yaml", text: yaml },
    glossaryMode: "default",
    glossaryText: "",
    ...overrides,
  };
}

function options(): PolystellaEmdashOptions {
  return {
    provider: { kind: "workers-ai-binding", binding: "AI" },
    catalogs: {
      defaultLocale: "en-US",
      locales: {
        "en-US": { dictionary: { greeting: "Hello" }, filePath: "src/i18n/en-US.json" },
        "fr-FR": { dictionary: { greeting: "Bonjour" }, filePath: "src/i18n/fr-FR.json" },
      },
    },
    models: { allowed: ["model-a"] },
    glossaryDefaults: { "fr-FR": { ...glossary, source: yaml } },
  };
}

describe("localeCustomization", () => {
  const unset = { model: null, reasoning: null };

  it("calls a language that overrides nothing Default and names what it inherits", () => {
    expect(localeCustomization(unset, locale({ defaultReasoning: "none" }))).toEqual({
      custom: false,
      summary: "Uses the default model, model-a, with thinking off and the code glossary.",
    });
    expect(localeCustomization({ model: "@cf/vendor/model-b", reasoning: null }, locale({ defaultGlossary: null }))).toEqual({
      custom: false,
      summary: "Uses the default model, model-b, and no glossary.",
    });
  });

  it("treats appending empty text as no change", () => {
    expect(localeCustomization(unset, locale({ glossaryMode: "append", glossaryText: "  " })).custom).toBe(false);
  });

  it("counts replacing as Custom only when it removes a code glossary or adds text", () => {
    expect(localeCustomization(unset, locale({ defaultGlossary: null, glossaryMode: "replace", glossaryText: " " })).custom).toBe(false);
    expect(localeCustomization(unset, locale({ defaultGlossary: null, glossaryMode: "replace", glossaryText: "x" })).custom).toBe(true);
    expect(localeCustomization(unset, locale({ glossaryMode: "replace", glossaryText: "" })).custom).toBe(true);
  });

  it("lists every change of a Custom language", () => {
    expect(
      localeCustomization(unset, locale({ model: "@cf/vendor/claude-haiku", reasoning: "low", glossaryMode: "append", glossaryText: "x" })),
    ).toEqual({ custom: true, summary: "Model: claude-haiku · Thinking: Low · Glossary: added to the code glossary" });
    expect(localeCustomization(unset, locale({ glossaryMode: "replace" })).summary).toBe("Glossary: replaces the code glossary");
  });
});

describe("code glossary source", () => {
  it("sends the YAML as written and the parsed terms without it", () => {
    const view = codeGlossaryView({ ...glossary, source: yaml });
    expect(view.defaultGlossarySource).toEqual({ format: "yaml", text: yaml });
    expect(view.defaultGlossary).toEqual(glossary);
    expect(view.defaultGlossary).not.toHaveProperty("source");
  });

  it("falls back to pretty JSON without a file, and to nothing without a glossary", () => {
    expect(codeGlossaryView(glossary).defaultGlossarySource).toEqual({ format: "json", text: JSON.stringify(glossary, null, 2) });
    expect(codeGlossaryView(undefined)).toEqual({ defaultGlossary: null, defaultGlossarySource: null });
  });

  it("leaves the source out unless asked", () => {
    expect(codeGlossaryView({ ...glossary, source: yaml }, false)).toEqual({ defaultGlossary: glossary, defaultGlossarySource: null });
  });

  it("survives serialization and stays out of the translation glossary", () => {
    const restored = deserializeOptions(serializeOptions(options()));
    expect(restored.glossaryDefaults?.["fr-FR"]?.source).toBe(yaml);
    expect(resolveGlossary(restored.glossaryDefaults?.["fr-FR"], "default", "")).toEqual(glossary);
  });

  it("rejects a source that isn't text", () => {
    const invalid: unknown = { ...options(), glossaryDefaults: { "fr-FR": { ...glossary, source: 42 } } };
    expect(() => validatePolystellaEmdashOptions(invalid)).toThrow(/source must be a string/);
  });

  it("limits a source to 1,000,000 characters without counting it against the terms", () => {
    const withSource = (source: string) => ({ ...options(), glossaryDefaults: { "fr-FR": { ...glossary, source } } });
    expect(() => validatePolystellaEmdashOptions(withSource("x".repeat(1_000_000)))).not.toThrow();
    expect(() => validatePolystellaEmdashOptions(withSource("x".repeat(1_000_001)))).toThrow(/source must be a string of at most 1000000/);
  });

  it("strips the source from every glossary mode, and from the hash", () => {
    const withSource = { ...glossary, source: yaml };
    for (const [mode, text] of [
      ["default", ""],
      ["default", "n"],
      ["append", ""],
      ["append", "n"],
      ["replace", "n"],
    ] as const) {
      expect(resolveGlossary(withSource, mode, text)).not.toHaveProperty("source");
    }
    expect(resolveGlossary(undefined, "append", "")).not.toHaveProperty("source");
    expect(resolveGlossary(withSource, "append", "n").notes).toBe("n");
    expect(hashGlossary(withSource)).toBe(hashGlossary(glossary));
  });

  it("keeps each glossary file's text when loading from files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "polystella-glossary-"));
    try {
      await writeFile(path.join(directory, "fr-FR.yaml"), yaml);
      const loaded = await loadGlossaryDefaults({
        locales: ["fr-FR"],
        file: "./{locale}.yaml",
        projectRoot: pathToFileURL(`${directory}/`),
      });
      expect(loaded["fr-FR"]?.source).toBe(yaml);
      expect(loaded["fr-FR"]?.doNotTranslate).toEqual(["Cloudflare", "Workers"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const inline = await loadGlossaryDefaults({ locales: ["fr-FR"], inline: { "fr-FR": { notes: "n" } } });
    expect(inline["fr-FR"]).not.toHaveProperty("source");
  });
});

describe("CodeGlossaryView", () => {
  it("opens on an overview of each section with the version and a copy button", () => {
    const terms = Array.from({ length: 45 }, (_, index) => `Term ${index}`);
    const html = renderToStaticMarkup(
      createElement(CodeGlossaryView, { glossary: { ...glossary, doNotTranslate: terms }, source: { format: "yaml", text: yaml } }),
    ).replaceAll("&#x27;", "'");
    expect(html).toContain("Don't translate");
    expect(html).toContain("45 terms");
    expect(html).toContain("Show all 45");
    expect(html).not.toContain("Term 44");
    expect(html).toContain("Tableau de bord");
    expect(html).toContain("Use vous.");
    expect(html).toContain("Version v1");
    expect(html).toContain("Copy YAML");
    expect(html).not.toContain("# kept as written");
  });

  it("labels the copy button JSON for an inline glossary", () => {
    const html = renderToStaticMarkup(createElement(CodeGlossaryView, { glossary, source: { format: "json", text: "{}" } }));
    expect(html).toContain("Copy JSON");
  });
});
