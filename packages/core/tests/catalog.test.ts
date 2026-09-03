import { describe, expect, it, vi } from "vitest";

import { buildTranslateFn, interpolate, resolveTranslations, type CatalogDictionary } from "../src/catalog/index.js";

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
