import { describe, expect, it } from "vitest";

import {
  assertLocaleTags,
  checkLocaleTags,
  formatLocaleTagIssues,
  parseLocaleTags,
  pluralCategories,
  requiredPluralCategories,
  resolveLocaleTag,
  supportedLocaleTag,
} from "../src/catalog/index.js";

describe("locale tags", () => {
  it("maps codes through localeTags and uses unmapped codes as-is", () => {
    expect(resolveLocaleTag("jp", { jp: "ja" })).toBe("ja");
    expect(resolveLocaleTag("pt-BR", { jp: "ja" })).toBe("pt-BR");
    expect(resolveLocaleTag("en")).toBe("en");
  });

  it("canonicalises supported tags and rejects unknown or malformed ones", () => {
    expect(supportedLocaleTag("pt-br")).toBe("pt-BR");
    expect(supportedLocaleTag("es-la")).toBe("es-LA");
    expect(supportedLocaleTag("jp")).toBeUndefined();
    expect(supportedLocaleTag("zh_cn")).toBeUndefined();
    expect(supportedLocaleTag(undefined)).toBeUndefined();
  });

  it("reports malformed, unsupported and undeclared tags", () => {
    const issues = checkLocaleTags(["en", "jp", "zh_cn", "cz"], { cz: "cs", xx: "fr" });

    expect(issues).toEqual([
      { locale: "xx", tag: "fr", reason: "undeclared" },
      { locale: "jp", tag: "jp", reason: "unsupported" },
      { locale: "zh_cn", tag: "zh_cn", reason: "malformed" },
    ]);
    expect(formatLocaleTagIssues(issues)).toContain('localeTags: { "jp": "<BCP 47 tag>" }');
    expect(checkLocaleTags(["en", "jp"], { jp: "ja" })).toEqual([]);
    expect(() => assertLocaleTags(["jp"], undefined, "polystella")).toThrow(/\[polystella\] invalid locale tags/);
  });

  it("parses untrusted localeTags values", () => {
    expect(parseLocaleTags(undefined, "x")).toBeUndefined();
    expect(parseLocaleTags({ jp: "ja" }, "x")).toEqual({ jp: "ja" });
    expect(() => parseLocaleTags(["ja"], "x")).toThrow(/must be an object/);
    expect(() => parseLocaleTags({ jp: "" }, "x")).toThrow(/localeTags.jp must be a non-empty string/);
  });

  it("lists plural categories in CLDR order", () => {
    expect(pluralCategories("en")).toEqual(["one", "other"]);
    expect(pluralCategories("pl")).toEqual(["one", "few", "many", "other"]);
    expect(pluralCategories("ar")).toEqual(["zero", "one", "two", "few", "many", "other"]);
    expect(pluralCategories("ja")).toEqual(["other"]);
    expect(pluralCategories("en", "ordinal")).toEqual(["one", "two", "few", "other"]);
  });

  it("requires only categories counts up to 1000 select, plus other", () => {
    expect(requiredPluralCategories("fr")).toEqual(["one", "other"]);
    expect(requiredPluralCategories("es")).toEqual(["one", "other"]);
    expect(requiredPluralCategories("cs")).toEqual(["one", "few", "other"]);
    expect(requiredPluralCategories("pl")).toEqual(["one", "few", "many", "other"]);
    expect(requiredPluralCategories("ar")).toEqual(["zero", "one", "two", "few", "many", "other"]);
    expect(requiredPluralCategories("en", "ordinal")).toEqual(["one", "two", "few", "other"]);
  });
});
