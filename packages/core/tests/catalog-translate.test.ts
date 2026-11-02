import { describe, expect, it, vi } from "vitest";

import { EMPTY_GLOSSARY, PermanentProviderError, type Translator } from "../src/index.js";
import {
  extractTokens,
  selectEmptyKeys,
  translateCatalogEntries,
  formatTokenValidationIssue,
  removeUnusedPluralBranches,
  translateUiStringsForLocale,
  validateMessage,
  validateMessageTranslation,
  validateTokenPreservation,
  withMessageRules,
  withTokenPreservationRule,
} from "../src/catalog/translate.js";

/**
 * Tests for the UI-string AI translation orchestrator.
 *
 * Pure helpers are tested directly (token extraction / validation /
 * empty-key selection). The orchestrator is tested with a stub
 * `Translator` that emits valid marker output — same pattern as
 * `tests/translation/provider.test.ts`.
 *
 * The token validator is the load-bearing safety check; its retry
 * behaviour and partial-result reporting are pinned by name.
 */

function makeStubTranslator(responses: Array<string | Error>): Translator & { calls: number } {
  let i = 0;
  const t = {
    modelId: "stub/ui",
    translate: vi.fn(async () => {
      const next = responses[i++];
      if (next === undefined) {
        throw new Error("stub translator exhausted");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }),
    calls: 0,
  } as Translator & { calls: number };
  // Expose the call count for assertions.
  Object.defineProperty(t, "calls", {
    get: () => (t.translate as ReturnType<typeof vi.fn>).mock.calls.length,
  });
  return t;
}

/** Build a valid marker-format response for a set of (id, text) pairs. */
function markerResponse(pairs: Array<[number, string]>): string {
  return pairs
    .flatMap(([id, text]) => [`@@catalog:${id}@@`, text, ""])
    .join("\n")
    .trim();
}

describe("extractTokens", () => {
  it("finds `{{name}}` placeholders with word-char names", () => {
    expect(extractTokens("Copyright ©{{year}}.")).toEqual(new Set(["year"]));
    expect(extractTokens("Hello {{name}}, you have {{count}} items.")).toEqual(new Set(["name", "count"]));
  });

  it("returns an empty set when no placeholders are present", () => {
    expect(extractTokens("Just plain text.")).toEqual(new Set());
  });

  it("dedupes repeated tokens", () => {
    expect(extractTokens("{{a}} and {{a}} again")).toEqual(new Set(["a"]));
  });

  it("ignores `{{ name }}` (whitespace inside braces — runtime rejects too)", () => {
    expect(extractTokens("{{ year }}")).toEqual(new Set());
  });

  it("ignores `{{name.dotted}}` (runtime grammar is `\\w+` only)", () => {
    expect(extractTokens("{{user.name}}")).toEqual(new Set());
  });
});

describe("validateTokenPreservation", () => {
  it("returns null when tokens match exactly", () => {
    expect(validateTokenPreservation("k", "Hello {{name}}", "Olá {{name}}")).toBeNull();
  });

  it("returns null for strings with no tokens on either side", () => {
    expect(validateTokenPreservation("k", "Hello", "Olá")).toBeNull();
  });

  it("flags a missing token (source has, translation doesn't)", () => {
    const issue = validateTokenPreservation("k", "Hello {{name}}", "Olá");
    expect(issue).toEqual({ key: "k", missing: ["name"], spurious: [] });
  });

  it("flags a spurious token (translation has, source doesn't)", () => {
    const issue = validateTokenPreservation("k", "Hello", "Olá {{name}}");
    expect(issue).toEqual({ key: "k", missing: [], spurious: ["name"] });
  });

  it("flags a renamed token as both missing and spurious", () => {
    const issue = validateTokenPreservation("k", "Hi {{name}}", "Olá {{nome}}");
    expect(issue).toEqual({ key: "k", missing: ["name"], spurious: ["nome"] });
  });

  it("flags multi-token mismatches with sorted output", () => {
    const issue = validateTokenPreservation("k", "{{z}}, {{a}}, {{m}}", "{{a}}");
    expect(issue?.missing).toEqual(["m", "z"]);
  });
});

describe("selectEmptyKeys", () => {
  it("returns keys with empty locale values when source is non-empty", () => {
    const pairs = selectEmptyKeys({ a: "A", b: "B", c: "C" }, { a: "ALocale", b: "" });
    expect(pairs).toEqual([
      { key: "b", source: "B" },
      { key: "c", source: "C" },
    ]);
  });

  it("skips keys with intentionally-empty source values", () => {
    const pairs = selectEmptyKeys({ blank: "", filled: "F" }, {});
    expect(pairs).toEqual([{ key: "filled", source: "F" }]);
  });

  it("returns no pairs when every key already has a locale value", () => {
    const pairs = selectEmptyKeys({ a: "A" }, { a: "ALocale" });
    expect(pairs).toEqual([]);
  });

  it("ignores inherited locale values", () => {
    const localeDict = Object.create({ title: "Inherited" }) as Record<string, string>;
    expect(selectEmptyKeys({ title: "Title" }, localeDict)).toEqual([{ key: "title", source: "Title" }]);
  });
});

describe("withTokenPreservationRule", () => {
  it("appends a placeholders style rule to the glossary", () => {
    const next = withTokenPreservationRule(EMPTY_GLOSSARY);
    expect(next.styleRules).toHaveLength(1);
    expect(next.styleRules[0]?.category).toBe("placeholders");
    expect(next.styleRules[0]?.instruction).toContain("`{{token}}`");
  });

  it("doesn't mutate the input glossary", () => {
    const before = JSON.stringify(EMPTY_GLOSSARY);
    withTokenPreservationRule(EMPTY_GLOSSARY);
    expect(JSON.stringify(EMPTY_GLOSSARY)).toBe(before);
  });

  it("preserves existing style rules and appends after them", () => {
    const seed = {
      ...EMPTY_GLOSSARY,
      styleRules: [{ category: "tone", instruction: "Use formal voice." }],
    };
    const next = withTokenPreservationRule(seed);
    expect(next.styleRules).toHaveLength(2);
    expect(next.styleRules[0]?.category).toBe("tone");
    expect(next.styleRules[1]?.category).toBe("placeholders");
  });
});

describe("translateUiStringsForLocale", () => {
  it("returns dict unchanged + empty filled list when no empties to translate", async () => {
    const translator = makeStubTranslator([]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A" },
      localeDict: { a: "ALocale" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    expect(result.dict).toEqual({ a: "ALocale" });
    expect(result.filled).toEqual([]);
    expect(result.tokenFailures).toEqual([]);
    expect(translator.calls).toBe(0);
  });

  it("batches every empty key into one LLM call", async () => {
    const translator = makeStubTranslator([
      markerResponse([
        [0, "Atrad"],
        [1, "Btrad"],
        [2, "Ctrad"],
      ]),
    ]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A", b: "B", c: "C" },
      localeDict: { a: "", b: "", c: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    expect(translator.calls).toBe(1);
    expect(result.dict).toEqual({ a: "Atrad", b: "Btrad", c: "Ctrad" });
    expect(result.filled).toEqual(["a", "b", "c"]);
    expect(result.tokenFailures).toEqual([]);
    expect(result.batchCount).toBe(1);
  });

  it("splits UI strings into multiple provider requests", async () => {
    const translator = makeStubTranslator([
      markerResponse([
        [0, "Atrad"],
        [1, "Btrad"],
      ]),
      markerResponse([[2, "Ctrad"]]),
    ]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A", b: "B", c: "C" },
      localeDict: { a: "", b: "", c: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxSegmentsPerBatch: 2,
    });
    expect(translator.calls).toBe(2);
    expect(result.batchCount).toBe(2);
    expect(result.dict).toEqual({ a: "Atrad", b: "Btrad", c: "Ctrad" });
    expect(result.filled).toEqual(["a", "b", "c"]);
  });

  it("retries only the failed UI-string request batch", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "Atrad"]]), new Error("provider timeout"), markerResponse([[1, "Btrad"]])]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A", b: "B" },
      localeDict: { a: "", b: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
      maxSegmentsPerBatch: 1,
    });
    expect(translator.calls).toBe(3);
    expect(result.batchCount).toBe(2);
    expect(result.dict).toEqual({ a: "Atrad", b: "Btrad" });
  });

  it("preserves existing non-empty locale values", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "Btrad"]])]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A", b: "B" },
      localeDict: { a: "ALocaleKept", b: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    expect(result.dict).toEqual({ a: "ALocaleKept", b: "Btrad" });
    expect(result.filled).toEqual(["b"]);
  });

  it("retries the whole batch on token-validation failure (with sampling variance)", async () => {
    // First attempt drops the {{year}} token; second preserves it.
    const translator = makeStubTranslator([
      markerResponse([[0, "Direitos reservados."]]),
      markerResponse([[0, "Direitos reservados {{year}}."]]),
    ]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { copyright: "Copyright ©{{year}}." },
      localeDict: { copyright: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });
    expect(translator.calls).toBe(2);
    expect(result.dict.copyright).toBe("Direitos reservados {{year}}.");
    expect(result.tokenFailures).toEqual([]);
  });

  it("reports token failures and leaves the key empty when retries exhaust", async () => {
    // Both attempts drop the token.
    const translator = makeStubTranslator([markerResponse([[0, "Direitos reservados."]]), markerResponse([[0, "Direitos reservados."]])]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { copyright: "Copyright ©{{year}}." },
      localeDict: { copyright: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });
    expect(translator.calls).toBe(2);
    // Key stays empty (load-bearing: a broken `{{year}}` page is
    // worse than an obviously-untranslated string).
    expect(result.dict.copyright).toBe("");
    expect(result.filled).toEqual([]);
    expect(result.tokenFailures).toHaveLength(1);
    expect(result.tokenFailures[0]).toEqual({
      key: "copyright",
      missing: ["year"],
      spurious: [],
    });
  });

  it("lands token-valid keys even when one key fails validation", async () => {
    // One bad translation in a batch shouldn't kill the others.
    const translator = makeStubTranslator([
      markerResponse([
        [0, "Bom"],
        [1, "Sem placeholder"], // drops {{token}}
      ]),
      markerResponse([
        [0, "Bom"],
        [1, "Sem placeholder ainda"], // still no token
      ]),
    ]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { good: "Good", bad: "Hello {{token}}" },
      localeDict: { good: "", bad: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });
    expect(result.dict.good).toBe("Bom");
    expect(result.dict.bad).toBe("");
    expect(result.filled).toEqual(["good"]);
    expect(result.tokenFailures).toHaveLength(1);
  });

  it("fires onRetry between failing attempts", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "no token"]]), markerResponse([[0, "with {{token}}"]])]);
    const onRetry = vi.fn();
    await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { k: "{{token}}" },
      localeDict: { k: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
      onRetry,
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]?.attempt).toBe(1);
    expect(onRetry.mock.calls[0]?.[0]?.totalAttempts).toBe(2);
  });

  it("re-throws provider errors on the final attempt", async () => {
    const translator: Translator = {
      modelId: "stub",
      translate: vi.fn(async () => {
        throw new Error("network ECONNRESET");
      }),
    };
    await expect(
      translateUiStringsForLocale({
        translator,
        glossary: EMPTY_GLOSSARY,
        sourceDict: { a: "A" },
        localeDict: { a: "" },
        sourceLocale: "en-US",
        targetLocale: "pt-BR",
        maxRetries: 0,
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });

  it("retries provider errors that aren't permanent", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 5xx"))
      .mockResolvedValueOnce(markerResponse([[0, "Atrad"]]));
    const translator: Translator = { modelId: "stub", translate };
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A" },
      localeDict: { a: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(result.dict.a).toBe("Atrad");
  });

  it("retries non-network TypeErrors", async () => {
    const translator = makeStubTranslator([new TypeError("temporary provider failure"), markerResponse([[0, "Atrad"]])]);
    const result = await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A" },
      localeDict: { a: "" },
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });

    expect(translator.calls).toBe(2);
    expect(result.dict.a).toBe("Atrad");
  });

  it("does not retry permanent provider errors", async () => {
    const translate = vi.fn(async () => {
      throw new PermanentProviderError("invalid credentials");
    });

    await expect(
      translateUiStringsForLocale({
        translator: { modelId: "stub", translate },
        glossary: EMPTY_GLOSSARY,
        sourceDict: { a: "A" },
        localeDict: { a: "" },
        sourceLocale: "en-US",
        targetLocale: "pt-BR",
        maxRetries: 2,
      }),
    ).rejects.toThrow("invalid credentials");
    expect(translate).toHaveBeenCalledOnce();
  });

  it("does not retry structurally tagged permanent TypeErrors", async () => {
    const error = Object.assign(new TypeError("invalid provider request"), { _tag: "PermanentProviderError" as const });
    const translator = makeStubTranslator([error]);

    await expect(
      translateUiStringsForLocale({
        translator,
        glossary: EMPTY_GLOSSARY,
        sourceDict: { a: "A" },
        localeDict: { a: "" },
        sourceLocale: "en-US",
        targetLocale: "pt-BR",
        maxRetries: 2,
      }),
    ).rejects.toThrow("invalid provider request");
    expect(translator.calls).toBe(1);
  });

  it("does not mutate the input localeDict", async () => {
    const localeDict = { a: "", b: "BLocale" };
    const before = JSON.stringify(localeDict);
    const translator = makeStubTranslator([markerResponse([[0, "Atrad"]])]);
    await translateUiStringsForLocale({
      translator,
      glossary: EMPTY_GLOSSARY,
      sourceDict: { a: "A", b: "B" },
      localeDict,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    expect(JSON.stringify(localeDict)).toBe(before);
  });
});

describe("translateCatalogEntries", () => {
  it("translates explicitly selected entries without a locale dictionary", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "Nova tradução"]])]);

    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [{ key: "existing", source: "Existing translation" }],
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(result.translations.get("existing")).toBe("Nova tradução");
    expect(result.tokenFailures).toEqual([]);
    expect(result.batchCount).toBe(1);
  });

  it("does not return translations that fail token validation", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "Direitos reservados."]])]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [{ key: "copyright", source: "Copyright {{year}}." }],
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(result.translations.has("copyright")).toBe(false);
    expect(result.tokenFailures).toEqual([{ key: "copyright", missing: ["year"], spurious: [] }]);
  });

  it("rejects duplicate keys before batching", async () => {
    const translator = makeStubTranslator([]);
    await expect(
      translateCatalogEntries({
        translator,
        glossary: EMPTY_GLOSSARY,
        entries: [
          { key: "duplicate", source: "First" },
          { key: "duplicate", source: "Second" },
        ],
        sourceLocale: "en-US",
        targetLocale: "pt-BR",
        maxSegmentsPerBatch: 1,
      }),
    ).rejects.toThrow('duplicate segment id "duplicate"');
    expect(translator.calls).toBe(0);
  });

  it("round-trips keys that are unsafe as prompt marker IDs", async () => {
    const key = "email@cta\nlabel\ud800";
    const translator = makeStubTranslator([markerResponse([[0, "Enviar e-mail"]])]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [{ key, source: "Send email" }],
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(result.translations.get(key)).toBe("Enviar e-mail");
  });
});

describe("validateMessageTranslation", () => {
  const roles = "{{count, plural, =0 {No roles} one {# role} other {# roles}}}";

  it("accepts translations with the target locale's plural categories", () => {
    expect(
      validateMessageTranslation("k", roles, "{{count, plural, =0 {Brak} one {# rola} few {# role} many {# ról} other {# roli}}}", "pl"),
    ).toBeNull();
    expect(validateMessageTranslation("k", roles, "{{count, plural, =0 {なし} other {# 件}}}", "ja")).toBeNull();
    expect(validateMessageTranslation("k", "Hi {{name}}", "Olá {{ name }}", "pt-BR")).toBeNull();
  });

  it("does not require categories only exact millions or decimals select", () => {
    expect(validateMessageTranslation("k", roles, "{{count, plural, =0 {Aucun} one {# poste} other {# postes}}}", "fr")).toBeNull();
    expect(validateMessageTranslation("k", roles, "{{count, plural, =0 {Ninguno} one {# puesto} other {# puestos}}}", "es")).toBeNull();
    expect(
      validateMessageTranslation("k", roles, "{{count, plural, =0 {Žádné} one {# role} few {# role} other {# rolí}}}", "cs"),
    ).toBeNull();
    expect(
      validateMessageTranslation("k", roles, "{{count, plural, =0 {Aucun} one {# poste} many {# postes} other {# postes}}}", "fr"),
    ).toBeNull();
  });

  it("formats failures without empty placeholder lists", () => {
    expect(formatTokenValidationIssue({ key: "roles", missing: [], spurious: [], problems: ["{{n}} plural is missing few for pl"] })).toBe(
      "roles: {{n}} plural is missing few for pl",
    );
    expect(formatTokenValidationIssue({ key: "hi", missing: ["name"], spurious: ["nome"] })).toBe(
      "hi: missing {{name}}; {{nome}} is not in the source",
    );
  });

  it("does not require # in every branch", () => {
    const ar = "{{count, plural, =0 {لا} zero {لا} one {وظيفة} two {وظيفتان} few {# وظائف} many {# وظيفة} other {# وظيفة}}}";
    expect(validateMessageTranslation("k", roles, ar, "ar")).toBeNull();
  });

  it("reports missing plural categories, invalid categories and lost =N branches", () => {
    const issue = validateMessageTranslation("k", roles, "{{count, plural, one {# rola} two {# role} other {# roli}}}", "pl");
    expect(issue?.problems).toEqual([
      "{{count}} plural branch two is never used in pl (use one, few, many, other)",
      "{{count}} plural is missing few, many for pl",
      "{{count}} plural lost exact branch =0",
    ]);
  });

  it("reports changed select keys, changed types and renamed placeholders", () => {
    const owner = "{{gender, select, female {Her} male {His} other {Their}}}";
    expect(validateMessageTranslation("k", owner, "{{gender, select, mujer {Su} other {Su}}}", "es")?.problems).toEqual([
      "{{gender}} select branches must match the source (female, male, other)",
    ]);
    expect(validateMessageTranslation("k", "{{n, number}} left", "{{n, plural, other {#}}} restantes", "es")?.problems).toContain(
      "{{n}} changed from number to plural",
    );
    expect(validateMessageTranslation("k", "Hi {{name}}", "Olá {{nome}}", "pt")).toEqual({
      key: "k",
      missing: ["name"],
      spurious: ["nome"],
    });
  });

  it("reports invalid translations and apostrophes that hide a placeholder", () => {
    expect(validateMessageTranslation("k", roles, "{{count, plural, one {# x}}}", "en")?.problems).toEqual([
      "invalid message: plural/select needs an `other` branch at offset 26",
    ]);
    const issue = validateMessageTranslation("k", "the {{company}} team", "l'{{company}}", "fr");
    expect(issue?.missing).toEqual(["company"]);
    expect(issue?.problems).toEqual(["an apostrophe hides {{company}}; write '' before it"]);
  });

  it("reports literal braces the source does not have", () => {
    const source = "See all {{count, plural, one {# role} other {# roles}}}";
    expect(validateMessageTranslation("k", source, "Alle {{count, plural, one {# Rolle} other {# Rollen}}}} sehen", "de")).toEqual({
      key: "k",
      missing: [],
      spurious: [],
      problems: ["stray } in the text; remove it, or quote it as '}'"],
    });
    expect(validateMessageTranslation("k", "Use {braces} here", "Utilisez {braces} ici", "fr")).toBeNull();
    expect(validateMessageTranslation("k", "Hi {{name}}", "{Hola {{name}}", "es")?.problems).toEqual([
      "stray { in the text; remove it, or quote it as '{'",
    ]);
  });

  it("falls back to token preservation when the source is not a valid message", () => {
    expect(validateMessageTranslation("k", "Hi {{user.name}} {{x}}", "Olá", "pt")).toEqual({ key: "k", missing: ["x"], spurious: [] });
  });
});

describe("validateMessage", () => {
  it("checks syntax and plural branches the locale never uses, but not missing ones", () => {
    expect(validateMessage("{{n, plural, one {# item} other {# items}}}", "en")).toEqual([]);
    expect(validateMessage("{{n, plural, one {# item} few {# items} other {# items}}}", "en")).toEqual([
      "{{n}} plural branch few is never used in en (use one, other)",
    ]);
    expect(validateMessage("{{n", "en")).toEqual(["invalid message: unclosed {{ at offset 0"]);
  });
});

describe("withMessageRules", () => {
  it("adds the apostrophe rule for placeholders and the ICU rule only for branching messages", () => {
    const plain = withMessageRules(EMPTY_GLOSSARY, ["Hello"], "pl");
    expect(plain.styleRules.map((rule) => rule.category)).toEqual(["placeholders"]);

    const token = withMessageRules(EMPTY_GLOSSARY, ["Hi {{name}}"], "pl");
    expect(token.styleRules.map((rule) => rule.category)).toEqual(["placeholders", "apostrophes"]);

    const plural = withMessageRules(
      EMPTY_GLOSSARY,
      ["{{n, plural, one {# a} other {# b}}}", "{{n, selectordinal, one {#st} other {#th}}}"],
      "pl",
    );
    const icu = plural.styleRules.find((rule) => rule.category === "icu-messages");
    expect(icu?.instruction).toContain("For plural, write these branches for pl: one, few, many, other; do not write any other category.");
    expect(icu?.instruction).toContain("For selectordinal, write these branches for pl: other;");
    const fr = withMessageRules(EMPTY_GLOSSARY, ["{{n, plural, one {# a} other {# b}}}"], "fr");
    expect(fr.styleRules.at(-1)?.instruction).toContain(
      "write these branches for fr: one, other; do not write any other category. You may also add: many.",
    );
  });

  it("puts the target's categories in the prompt and retries a plural mismatch", async () => {
    const translator = makeStubTranslator([
      markerResponse([[0, "{{n, plural, one {# plik} other {# pliki}}}"]]),
      markerResponse([[0, "{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}"]]),
    ]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [{ key: "files", source: "{{n, plural, one {# file} other {# files}}}" }],
      sourceLocale: "en",
      targetLocale: "pl",
      maxRetries: 1,
    });

    const systemPrompt = vi.mocked(translator.translate).mock.calls[0]?.[0];
    expect(systemPrompt).toContain("one, few, many, other");
    expect(translator.calls).toBe(2);
    expect(result.translations.get("files")).toBe("{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}");
    expect(result.tokenFailures).toEqual([]);
  });
});

describe("removeUnusedPluralBranches", () => {
  it("cuts branches the target never selects and keeps exact branches, other text and nesting intact", () => {
    expect(removeUnusedPluralBranches("{{n, plural, =0 {なし} one {# 件} other {# 件}}}", "ja")).toBe(
      "{{n, plural, =0 {なし} other {# 件}}}",
    );
    expect(removeUnusedPluralBranches("Showing {{v}} of {{t, plural, one {# rôle} two {# rôles} other {# rôles}}}!", "fr")).toBe(
      "Showing {{v}} of {{t, plural, one {# rôle} other {# rôles}}}!",
    );
    expect(
      removeUnusedPluralBranches("{{a, plural, one {{{b, plural, one {x} other {y}}}} other {{{b, plural, one {x} other {z}}}}}}", "ko"),
    ).toBe("{{a, plural, other {{{b, plural, other {z}}}}}}");
    expect(removeUnusedPluralBranches("{{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}}", "fr")).toBe(
      "{{n, selectordinal, one {#st} other {#th}}}",
    );
    expect(removeUnusedPluralBranches("{{g, select, one {x} other {y}}}", "ja")).toBe("{{g, select, one {x} other {y}}}");
    expect(removeUnusedPluralBranches("{{n, plural, one {x}", "ja")).toBe("{{n, plural, one {x}");
  });

  it("strips unused branches from model output before validating", async () => {
    const translator = makeStubTranslator([markerResponse([[0, "{{count, plural, one {# 件の求人} other {# 件の求人}}}"]])]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [{ key: "roles", source: "{{count, plural, one {# role} other {# roles}}}" }],
      sourceLocale: "en",
      targetLocale: "ja",
    });

    expect(result.tokenFailures).toEqual([]);
    expect(result.translations.get("roles")).toBe("{{count, plural, other {# 件の求人}}}");
  });
});

describe("catalog retries with corrections", () => {
  it("resends only failed segments, naming the previous answer and its problem", async () => {
    const translator = makeStubTranslator([
      markerResponse([
        [0, "Bom"],
        [1, "{{n, plural, one {# plik} other {# pliki}}}"],
      ]),
      markerResponse([[1, "{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}"]]),
    ]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [
        { key: "good", source: "Good" },
        { key: "files", source: "{{n, plural, one {# file} other {# files}}}" },
      ],
      sourceLocale: "en",
      targetLocale: "pl",
      maxRetries: 1,
    });

    const calls = vi.mocked(translator.translate).mock.calls;
    expect(calls[0]?.[0]).not.toContain("CORRECTIONS");
    const [retrySystem, retryUser] = calls[1] ?? [];
    expect(retrySystem).toContain("- Segment catalog:1\n  Previous answer: {{n, plural, one {# plik} other {# pliki}}}");
    expect(retrySystem).toContain("  Problem: {{n}} plural is missing few, many for pl");
    expect(retryUser).toContain("@@catalog:1@@");
    expect(retryUser).not.toContain("@@catalog:0@@");
    expect(result.translations).toEqual(
      new Map([
        ["good", "Bom"],
        ["files", "{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}"],
      ]),
    );
    expect(result.tokenFailures).toEqual([]);
  });

  it("keeps earlier valid translations when the last attempt still fails", async () => {
    const translator = makeStubTranslator([
      markerResponse([
        [0, "Bom"],
        [1, "Sem placeholder"],
      ]),
      markerResponse([[1, "Ainda sem placeholder"]]),
    ]);
    const result = await translateCatalogEntries({
      translator,
      glossary: EMPTY_GLOSSARY,
      entries: [
        { key: "good", source: "Good" },
        { key: "bad", source: "Hello {{name}}" },
      ],
      sourceLocale: "en",
      targetLocale: "pt-BR",
      maxRetries: 1,
    });

    expect(vi.mocked(translator.translate).mock.calls[1]?.[0]).toContain("Problem: missing {{name}}");
    expect(result.translations).toEqual(new Map([["good", "Bom"]]));
    expect(result.tokenFailures).toEqual([{ key: "bad", missing: ["name"], spurious: [] }]);
  });
});
