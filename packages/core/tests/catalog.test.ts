import { describe, expect, it, vi } from "vitest";

import {
  buildTranslateFn,
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
