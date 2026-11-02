import { describe, expect, it, vi } from "vitest";

import {
  buildTranslateFn,
  createPassthroughTranslateFn,
  detectCatalogFormat,
  flattenCatalog,
  formatNestedLocaleFile,
  interpolate,
  resolveTranslations,
  type CatalogDictionary,
} from "../src/catalog/index.js";

describe("catalog runtime", () => {
  it("translates, interpolates, falls back, then returns the literal key", () => {
    const translate = buildTranslateFn({ greeting: "Olá, {{name}}" }, { goodbye: "Goodbye" });

    expect(translate("greeting", { name: "Diogo" })).toBe("Olá, Diogo");
    expect(translate("goodbye")).toBe("Goodbye");
    expect(translate("missing")).toBe("missing");
    expect(interpolate("{{count}} enabled: {{enabled}}", { count: 2, enabled: true })).toBe("2 enabled: true");
  });

  it("loads sync or async dictionaries with default-locale fallback", async () => {
    const dictionaries: Record<string, CatalogDictionary | undefined> = {
      "en-US": { home: "Home", about: "About" },
      "pt-BR": { home: "Início" },
    };
    const getDictionary = vi.fn((locale: string) => (locale === "pt-BR" ? Promise.resolve(dictionaries[locale]) : dictionaries[locale]));

    const translate = await resolveTranslations("pt-BR", { defaultLocale: "en-US", getDictionary });

    expect(translate("home")).toBe("Início");
    expect(translate("about")).toBe("About");
    expect(getDictionary).toHaveBeenCalledTimes(2);
  });

  it("uses the default locale for an empty locale and can disable fallback", async () => {
    const getDictionary = vi.fn((locale: string) => ({ "en-US": { home: "Home" } })[locale]);
    const defaultTranslate = await resolveTranslations("", { defaultLocale: "en-US", getDictionary });
    const noFallback = await resolveTranslations("pt-BR", {
      defaultLocale: "en-US",
      getDictionary,
      fallbackToDefault: false,
    });

    expect(defaultTranslate("home")).toBe("Home");
    expect(noFallback("home")).toBe("home");
  });

  it("ignores inherited translations and interpolation parameters", () => {
    const dictionary = Object.create({ constructor: "Inherited translation" }) as CatalogDictionary;
    const params = Object.create({ name: "Inherited name" }) as Record<string, string>;

    expect(buildTranslateFn(dictionary)("constructor")).toBe("constructor");
    expect(interpolate("Hello {{name}}", params)).toBe("Hello {{name}}");
  });

  it("formats plurals with the locale's rules, and fallback strings with the fallback locale's rules", () => {
    const translate = buildTranslateFn(
      { files: "{{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}}" },
      { files: "{{n, plural, one {# file} other {# files}}}", visits: "{{n, plural, one {# visit} other {# visits}}}" },
      { locale: "pl", fallbackLocale: "en" },
    );

    expect(translate("files", { n: 5 })).toBe("5 plików");
    expect(translate("visits", { n: 1000 })).toBe("1,000 visits");
    expect(translate.locale).toBe("pl");
  });

  it("falls back to the default-locale string when the visitor string is broken, then to the key", () => {
    const translate = buildTranslateFn(
      { roles: "{{n, plural, one {# rol}}}", both: "{{broken" },
      { roles: "{{n, plural, one {# role} other {# roles}}}", both: "{{also broken" },
      { locale: "es", fallbackLocale: "en" },
    );

    expect(translate("roles", { n: 2 })).toBe("2 roles");
    expect(translate.raw("roles")).toBe("{{n, plural, one {# role} other {# roles}}}");
    expect(translate("both")).toBe("both");
    expect(translate.raw("both")).toBe("both");
  });

  it("always formats, so '' renders as an apostrophe even without params", () => {
    const translate = buildTranslateFn({ company: "l''équipe {{name}}", plain: "Don't" }, undefined, { locale: "fr" });

    expect(translate("company")).toBe("l'équipe {{name}}");
    expect(translate("plain")).toBe("Don't");
    expect(translate.raw("company")).toBe("l''équipe {{name}}");
  });

  it("uses the fallback locale's tag when the visitor tag is unknown", () => {
    const translate = buildTranslateFn({ n: "{{n, number}}" }, undefined, { locale: "english", fallbackLocale: "de" });

    expect(translate.locale).toBe("de");
    expect(translate("n", { n: 1234.5 })).toBe("1.234,5");
  });

  it("maps site locale codes through localeTags", async () => {
    const getDictionary = (locale: string) =>
      ({
        en: { items: "{{n, plural, one {# item} other {# items}}}" },
        jp: { items: "{{n, plural, other {# 件}}}" },
      })[locale];
    const translate = await resolveTranslations("jp", { defaultLocale: "en", getDictionary, localeTags: { jp: "ja" } });

    expect(translate.locale).toBe("ja");
    expect(translate("items", { n: 1 })).toBe("1 件");
  });

  it("creates a passthrough translator with a locale", () => {
    const translate = createPassthroughTranslateFn("pt-br");

    expect(translate("nav.home", { n: 1 })).toBe("nav.home");
    expect(translate.raw("nav.home")).toBe("nav.home");
    expect(translate.locale).toBe("pt-BR");
    expect(createPassthroughTranslateFn().locale).toBe("und");
  });
});

describe("catalog flattening", () => {
  it("detects flat vs nested formats", () => {
    expect(detectCatalogFormat({ "site.title": "X" })).toBe("flat");
    expect(detectCatalogFormat({})).toBe("flat");
    expect(detectCatalogFormat({ site: { title: "X" } })).toBe("nested");
    expect(detectCatalogFormat({ a: "x", site: { title: "X" } })).toBe("nested");
  });

  it("flattens nested groups to dotted keys and skips group titles", () => {
    expect(
      flattenCatalog({
        "site.title": "Cloudflare Blog",
        nav: {
          i18n_group_title: "Navigation",
          home: "Home",
          menu: { i18n_group_title: "Menu", ai: "AI" },
        },
      }),
    ).toEqual({
      "site.title": "Cloudflare Blog",
      "nav.home": "Home",
      "nav.menu.ai": "AI",
    });
  });

  it("passes flat dictionaries through unchanged, including a literal i18n_group_title key", () => {
    expect(flattenCatalog({ "site.title": "X", i18n_group_title: "Top" })).toEqual({
      "site.title": "X",
      i18n_group_title: "Top",
    });
    const prototypeKey = flattenCatalog(JSON.parse('{"__proto__":"Safe"}'));
    expect(Object.hasOwn(prototypeKey, "__proto__")).toBe(true);
    expect(prototypeKey.__proto__).toBe("Safe");
  });

  it("writes flattened values back into the nested source shape", () => {
    const source = { product: "Product", nav: { i18n_group_title: "Navigation", home: "Home" } };
    expect(formatNestedLocaleFile({ dict: { product: "Produit", "nav.home": "Accueil" }, source, existing: source })).toBe(
      '{\n  "product": "Produit",\n\n  "nav": {\n    "i18n_group_title": "Navigation",\n    "home": "Accueil"\n  }\n}\n',
    );
  });

  it("throws on non-string leaves and on key collisions", () => {
    expect(() => flattenCatalog({ a: 1 })).toThrow(/must be a string or an object of strings/);
    expect(() => flattenCatalog({ a: ["x"] })).toThrow(/must be a string or an object of strings/);
    expect(() => flattenCatalog({ "a.b": "flat", a: { b: "nested" } })).toThrow(/defined more than once/);
    expect(() => flattenCatalog("not an object")).toThrow(/must be a JSON object/);
  });
});
