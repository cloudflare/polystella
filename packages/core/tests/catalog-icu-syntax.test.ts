import { describe, expect, it, vi } from "vitest";

import { EMPTY_GLOSSARY, type Translator } from "../src/index.js";
import { buildTranslateFn, formatMessage, messageArgumentNames, resolveTranslations } from "../src/catalog/index.js";
import { MessageSyntaxError, parseMessage } from "../src/catalog/message.js";
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

function syntaxErrorOffset(template: string, syntax: "icu" | "polystella"): number | undefined {
  try {
    parseMessage(template, syntax);
  } catch (error) {
    if (error instanceof MessageSyntaxError) return error.offset;
    throw error;
  }
  throw new Error(`expected "${template}" to be invalid`);
}

describe("MessageSyntaxError offsets with surrogate pairs", () => {
  it("points at the UTF-16 index in the original string after emoji", () => {
    const unclosed = "😀😀 {name";
    expect(syntaxErrorOffset(unclosed, "icu")).toBe(unclosed.indexOf("{"));
    const badType = "😀😀 {name, bogus}";
    expect(syntaxErrorOffset(badType, "icu")).toBe(badType.indexOf("bogus"));
    const polystellaBadType = "😀😀 {{name, bogus}}";
    expect(syntaxErrorOffset(polystellaBadType, "polystella")).toBe(polystellaBadType.indexOf("bogus"));
    expect(syntaxErrorOffset("😀 {{name", "polystella")).toBe("😀 ".length);
  });

  it("includes the offset in the described error", () => {
    expect(validateMessage("😀 {name", "en", "icu")).toEqual(["invalid message: unclosed placeholder or branch at offset 3"]);
  });
});

describe('formatMessage in "icu" mode: more message types', () => {
  const ITEMS = "Items: {n, plural, one {# a} other {# b}} for {who}";

  it("renders an unusable plural value as its source text with single braces", () => {
    expect(formatMessage(ITEMS, { n: "many", who: "Ann" }, "en", "icu")).toBe("Items: {n, plural, one {# a} other {# b}} for Ann");
    expect(formatMessage(ITEMS, { who: "Ann" }, "en", "icu")).toBe("Items: {n, plural, one {# a} other {# b}} for Ann");
  });

  it("keeps a missing placeholder inside a used plural branch visible as {name}", () => {
    expect(formatMessage("{n, plural, one {# item for {who}} other {# items for {who}}}", { n: 2 }, "en", "icu")).toBe("2 items for {who}");
  });

  it("formats select and falls back to other", () => {
    const text = "{g, select, male {He} female {She} other {They}}";
    expect(formatMessage(text, { g: "female" }, "en", "icu")).toBe("She");
    expect(formatMessage(text, { g: "zzz" }, "en", "icu")).toBe("They");
    expect(formatMessage(text, {}, "en", "icu")).toBe(text);
  });

  it("formats selectordinal", () => {
    const text = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect(formatMessage(text, { n: 22 }, "en", "icu")).toBe("22nd");
    expect(formatMessage(text, { n: 11 }, "en", "icu")).toBe("11th");
    expect(formatMessage(text, { n: "first" }, "en", "icu")).toBe(text);
  });

  it("formats number skeletons and dates, leaving unusable values as source", () => {
    expect(formatMessage("{n, number, ::percent}", { n: 0.5 }, "en", "icu")).toBe("50%");
    expect(formatMessage("{n, number, ::percent}", { n: "x" }, "en", "icu")).toBe("{n, number, ::percent}");
    expect(formatMessage("on {d, date, short}", { d: new Date(Date.UTC(2020, 0, 5, 12)) }, "en", "icu")).toBe("on 1/5/20");
    expect(formatMessage("on {d, date, short}", { d: new Date("nope") }, "en", "icu")).toBe("on {d, date, short}");
  });
});

describe('validateMessageTranslation in "icu" mode: kinds, quotes and branches', () => {
  it("flags a quoted source placeholder as an apostrophe hiding it", () => {
    expect(validateMessageTranslation("k", "Hi {name}", "Hi '{name}'", "de", "icu")).toEqual({
      key: "k",
      missing: ["name"],
      spurious: [],
      problems: ["an apostrophe hides {name}; write '' before it"],
      messageSyntax: "icu",
    });
  });

  it("allows a literal quoted brace that is not a source placeholder", () => {
    expect(validateMessageTranslation("k", "Hi {name}", "Hi {name} '{'x'}'", "de", "icu")).toBeNull();
  });

  it('still flags a quoted-brace literal under "polystella" (stray brace check)', () => {
    expect(validateMessageTranslation("k", "Hi {{name}}", "Hi {{name}} '{'x'}'", "de")?.problems).toEqual([
      "stray { in the text; remove it, or quote it as '{'",
      "stray } in the text; remove it, or quote it as '}'",
    ]);
  });

  it("flags a changed number skeleton and accepts an identical one", () => {
    expect(validateMessageTranslation("k", "{n, number, ::percent}", "{n, number, ::percent}", "de", "icu")).toBeNull();
    expect(validateMessageTranslation("k", "{n, number, ::percent}", "{n, number, ::currency/USD}", "de", "icu")?.problems).toEqual([
      expect.stringMatching(/^\{n\} changed from number, ::/),
    ]);
  });

  it("requires select keys to match", () => {
    expect(
      validateMessageTranslation("k", "{g, select, a {A} other {B}}", "{g, select, a {A} b {C} other {B}}", "de", "icu")?.problems,
    ).toEqual(["{g} select branches must match the source (a, other)"]);
  });

  it("checks selectordinal categories and rejects switching to plural", () => {
    const source = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect(validateMessageTranslation("k", source, "{n, selectordinal, other {#.}}", "de", "icu")).toBeNull();
    expect(validateMessageTranslation("k", source, "{n, plural, other {#.}}", "de", "icu")?.problems).toContain(
      "{n} changed from selectordinal to plural",
    );
    expect(validateMessage("{n, selectordinal, one {#st} other {#th}}", "de", "icu")).toEqual([
      "{n} selectordinal branch one is never used in de (use other)",
    ]);
  });

  it("rejects the doubled-brace dialect as invalid ICU", () => {
    expect(validateMessage("Hi {{name}}", "en", "icu")).toEqual([expect.stringContaining("at offset 3")]);
  });
});

describe("resolveTranslations in icu mode", () => {
  it("falls back to the default locale when the visitor string is invalid ICU", async () => {
    const t = await resolveTranslations("de", {
      defaultLocale: "en",
      messageSyntax: "icu",
      getDictionary: async (locale) =>
        locale === "de" ? { hi: "Hallo {{name}}", ok: "Servus {name}" } : { hi: "Hello {name}", ok: "Hi {name}" },
    });
    expect(t("hi", { name: "Ann" })).toBe("Hello Ann");
    expect(t.raw("hi")).toBe("Hello {name}");
    expect(t("ok", { name: "Ann" })).toBe("Servus Ann");
  });

  it("returns the key when neither catalog has a valid string", async () => {
    const t = await resolveTranslations("de", {
      defaultLocale: "en",
      messageSyntax: "icu",
      getDictionary: async () => ({ hi: "Hi {{name}}" }),
    });
    expect(t("hi", { name: "Ann" })).toBe("hi");
  });

  it('uses "polystella" when messageSyntax is omitted', async () => {
    const t = await resolveTranslations("de", {
      defaultLocale: "en",
      getDictionary: async (locale) => (locale === "de" ? { hi: "Hallo {name}" } : { hi: "Hello {{name}}" }),
    });
    expect(t("hi", { name: "Ann" })).toBe("Hallo {name}");
  });
});

describe('default "polystella" behaviour is unchanged', () => {
  it("parses the same inputs differently per syntax without leaking between caches", () => {
    expect(formatMessage("{{n, plural, one {# item} other {# items}}}", { n: 1 }, "en")).toBe("1 item");
    expect(formatMessage("{{n, plural, one {# item} other {# items}}}", { n: 1 }, "en", "polystella")).toBe("1 item");
    expect(formatMessage("{n, plural, one {# item} other {# items}}", { n: 1 }, "en")).toBe("{n, plural, one {# item} other {# items}}");
    expect(formatMessage("Use {braces} and {{name}}", { name: "Ann" }, "en")).toBe("Use {braces} and Ann");
    expect(formatMessage("{{n, number, ::percent}}", { n: "x" }, "en")).toBe("{{n, number, ::percent}}");
  });

  it("reports polystella offsets for a stray }", () => {
    expect(syntaxErrorOffset("😀 {{name}", "polystella")).toBe("😀 {{name".length);
  });

  it("keeps the withMessageRules output byte for byte", () => {
    const rules = withMessageRules(EMPTY_GLOSSARY, ["Hi {{name}}", "{{n, plural, one {# a} other {# b}}}"], "en").styleRules;
    expect(rules).toEqual([
      {
        category: "placeholders",
        instruction:
          "Preserve every `{{token}}` placeholder verbatim - same name, same braces, same position relative to the surrounding text. Do not translate, rename, or remove them.",
        example: "Copyright ©{{year}}. -> Copyright ©{{year}}.",
      },
      {
        category: "apostrophes",
        instruction:
          "An apostrophe written directly before `{{`, before `}` or before `#` inside a plural branch must be doubled (`''`). Everywhere else write a single apostrophe.",
        example: "the {{company}} team -> l''équipe {{company}}",
      },
      {
        category: "icu-messages",
        instruction:
          "Some strings are ICU messages such as `{{count, plural, one {...} other {...}}}`. Keep the double outer braces, the placeholder name, the keyword (plural, select, selectordinal) and the single braces around each branch; translate only the text inside the branches. `#` inside a plural branch stands for the number. Keep select keys and exact `=N` branches as written. For plural, write these branches for en: one, other; do not write any other category.",
        example: "{{count, plural, =0 {No roles} one {# role} other {# roles}}}",
      },
    ]);
  });

  it("does not add the apostrophe rule for single-brace sources under polystella", () => {
    expect(withMessageRules(EMPTY_GLOSSARY, ["Hi {name}"], "en").styleRules.map((rule) => rule.category)).toEqual(["placeholders"]);
  });
});

describe('messageSyntax "icu": review follow-ups', () => {
  it("explains an apostrophe that hides a non-ASCII placeholder name", () => {
    expect(validateMessageTranslation("k", "Ahoj {jméno}", "Ahoj '{jméno}'", "cs", "icu")).toMatchObject({
      missing: ["jméno"],
      problems: ["an apostrophe hides {jméno}; write '' before it"],
    });
  });

  it("removes unused plural branches at the right offsets after an emoji", () => {
    expect(removeUnusedPluralBranches("😀 {n, plural, one {# 件} other {# 件}} 😀", "ja", "icu")).toBe("😀 {n, plural, other {# 件}} 😀");
  });
});
