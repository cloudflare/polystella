import { describe, expect, it, vi } from "vitest";

import { EMPTY_GLOSSARY, type Translator } from "../src/index.js";
import { buildTranslateFn, formatMessage, messageArgumentNames } from "../src/catalog/index.js";
import {
  formatTokenValidationIssue,
  removeUnusedPluralBranches,
  translateCatalogEntries,
  validateMessage,
  validateMessageTranslation,
  withMessageRules,
} from "../src/catalog/translate.js";

describe('messageSyntax "icu": issue #66 rows', () => {
  it("flags renamed, translated and dropped single-brace placeholders", () => {
    expect(validateMessageTranslation("k", "Hello {name}", "Hallo {Name}", "de", "icu")).toEqual({
      key: "k",
      missing: ["name"],
      spurious: ["Name"],
      messageSyntax: "icu",
    });
    expect(validateMessageTranslation("k", "Hello {name}", "Hallo {jméno}", "cs", "icu")).toMatchObject({
      missing: ["name"],
      spurious: ["jméno"],
    });
    expect(validateMessageTranslation("k", "Hello {name}", "Hallo", "de", "icu")).toMatchObject({ missing: ["name"], spurious: [] });
    expect(validateMessageTranslation("k", "Hello {name}", "Hallo {name}", "de", "icu")).toBeNull();
  });

  it('keeps today\'s results for {{name}} rows under "polystella"', () => {
    expect(validateMessageTranslation("k", "Hello {{name}}", "Hallo {{Name}}", "de")).toEqual({
      key: "k",
      missing: ["name"],
      spurious: ["Name"],
    });
    expect(validateMessageTranslation("k", "Hello {{name}}", "Hallo", "de")).toEqual({ key: "k", missing: ["name"], spurious: [] });
    expect(validateMessageTranslation("k", "Hello {name}", "Hallo {Name}", "de")).toBeNull();
  });

  it("describes issues with single braces", () => {
    const issue = validateMessageTranslation("k", "Hello {name}", "Hallo {Name}", "de", "icu");
    if (issue === null) throw new Error("expected an issue");
    expect(formatTokenValidationIssue(issue)).toBe("k: missing {name}; {Name} is not in the source");
  });
});

describe('messageSyntax "icu": messages', () => {
  const ITEMS = "{count, plural, =0 {No items} one {# item} other {# items}}";

  it("runs plurals through the plural-category checks", () => {
    expect(validateMessage(ITEMS, "en", "icu")).toEqual([]);
    expect(
      validateMessageTranslation("k", ITEMS, "{count, plural, =0 {Brak} one {# element} other {# elementów}}", "pl", "icu"),
    ).toMatchObject({
      problems: ["{count} plural is missing few, many for pl"],
    });
    expect(validateMessageTranslation("k", ITEMS, "{count, plural, one {# Ding} other {# Dinge}}", "de", "icu")).toMatchObject({
      problems: ["{count} plural lost exact branch =0"],
    });
    expect(removeUnusedPluralBranches("{n, plural, one {# 件} other {# 件}}", "ja", "icu")).toBe("{n, plural, other {# 件}}");
  });

  it("formats standard ICU and leaves unusable placeholders visible as {name}", () => {
    expect(formatMessage("Hello {name}", { name: "Ann" }, "en", "icu")).toBe("Hello Ann");
    expect(formatMessage(ITEMS, { count: 2 }, "en", "icu")).toBe("2 items");
    expect(formatMessage("Hello {name}", {}, "en", "icu")).toBe("Hello {name}");
    expect(formatMessage("Use '{'braces'}'", {}, "en", "icu")).toBe("Use {braces}");
  });

  it("caches parses and formatters per syntax", () => {
    expect(formatMessage("Hi {name}", { name: "Ann" }, "en", "icu")).toBe("Hi Ann");
    expect(formatMessage("Hi {name}", { name: "Ann" }, "en")).toBe("Hi {name}");
    expect(formatMessage("Hi {name}", { name: "Ann" }, "en", "icu")).toBe("Hi Ann");
    expect(messageArgumentNames("Hi {{name}}")).toEqual(new Set(["name"]));
    expect(() => messageArgumentNames("Hi {{name}}", "icu")).toThrow(/invalid message/);
    expect(messageArgumentNames("Hi {{name}}")).toEqual(new Set(["name"]));
  });

  it("explains an apostrophe that quotes a placeholder away", () => {
    expect(validateMessageTranslation("k", "the {company} team", "l'{company}", "fr", "icu")).toMatchObject({
      missing: ["company"],
      problems: ["an apostrophe hides {company}; write '' before it"],
    });
    expect(validateMessageTranslation("k", "the {company} team", "l''équipe {company}", "fr", "icu")).toBeNull();
    expect(formatMessage("l''{company}", { company: "Acme" }, "fr", "icu")).toBe("l'Acme");
    expect(validateMessage("Type '{name}' here", "en", "icu")).toEqual([]);
  });

  it("reports sources that are not valid ICU and doesn't check their translations", () => {
    expect(validateMessage("{rate: number style=percent} off", "en", "icu")).toEqual([
      expect.stringMatching(/^invalid message: invalid placeholder \(ICU placeholders are \{name\}/),
    ]);
    expect(validateMessageTranslation("k", "{rate: number style=percent} off", "anything", "de", "icu")).toBeNull();
  });

  it("formats t() with the configured syntax", () => {
    const icu = buildTranslateFn({ hi: "Hallo {name}" }, { hi: "Hello {name}" }, { locale: "de", messageSyntax: "icu" });
    expect(icu("hi", { name: "Ann" })).toBe("Hallo Ann");
    const polystella = buildTranslateFn({ hi: "Hallo {name}" }, undefined, { locale: "de" });
    expect(polystella("hi", { name: "Ann" })).toBe("Hallo {name}");
  });
});

describe('messageSyntax "icu": translation', () => {
  it("writes the prompt rules with single braces", () => {
    const rules = withMessageRules(EMPTY_GLOSSARY, ["Hi {name}", "{n, plural, one {# x} other {# xs}}"], "fr", "icu").styleRules;
    const text = rules.map(({ instruction, example }) => `${instruction} ${example ?? ""}`).join("\n");
    expect(text).toContain("Preserve every `{token}` placeholder");
    expect(text).toContain("starts a quote, so it must be doubled (`''`)");
    expect(text).toContain("{count, plural, =0 {No roles} one {# role} other {# roles}}");
    expect(text).not.toContain("{{");
  });

  it("never sends a source that is not valid ICU, and reports it", async () => {
    const translator: Translator = { modelId: "stub/ui", translate: vi.fn(async () => "@@catalog:0@@\nHallo {name}") };
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [
        { key: "markup", source: "{#b}Hi{/b}" },
        { key: "hi", source: "Hi {name}" },
      ],
      sourceLocale: "en",
      targetLocale: "de",
      messageSyntax: "icu",
    });
    expect(result.translations).toEqual(new Map([["hi", "Hallo {name}"]]));
    expect(result.tokenFailures).toEqual([
      {
        key: "markup",
        missing: [],
        spurious: [],
        problems: [
          expect.stringMatching(
            /^the source is not a valid ICU message \(invalid message: .*\); fix it or add its key to catalog\.ignoreKeys$/,
          ),
        ],
        messageSyntax: "icu",
      },
    ]);
    expect(translator.translate).toHaveBeenCalledTimes(1);
  });
});
