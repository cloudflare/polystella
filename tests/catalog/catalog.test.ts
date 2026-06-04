import { describe, expect, it } from "vitest";

describe("polystella/catalog", () => {
  it("imports without Astro virtual modules and translates with interpolation", async () => {
    const catalog = await import("../../src/catalog/index.js");
    const t = catalog.buildTranslateFn({ greeting: "Hi, {{name}}" });
    expect(t("greeting", { name: "Diogo" })).toBe("Hi, Diogo");
  });

  it("resolves requested dictionaries with default fallback, then literal key", async () => {
    const catalog = await import("../../src/catalog/index.js");
    const dictionaries: Record<string, Record<string, string> | undefined> = {
      "en-US": { "nav.home": "Home", "nav.about": "About" },
      "pt-BR": { "nav.home": "Início" },
    };

    const t = await catalog.resolveTranslations("pt-BR", {
      defaultLocale: "en-US",
      getDictionary: (locale) => dictionaries[locale],
    });

    expect(t("nav.home")).toBe("Início");
    expect(t("nav.about")).toBe("About");
    expect(t("missing.key")).toBe("missing.key");
  });

  it("exposes drift and sync helpers through the catalog surface", async () => {
    const catalog = await import("../../src/catalog/index.js");

    const drift = catalog.checkCatalogDrift({
      defaultLocale: "en-US",
      locales: ["en-US", "pt-BR"],
      dictionaries: {
        "en-US": { a: "A", b: "B" },
        "pt-BR": { a: "ALocale" },
      },
    });
    expect(drift.ok).toBe(false);
    expect(drift.issues[0]?.missing).toEqual(["b"]);

    const sync = catalog.syncLocaleDict({
      source: { a: "A", b: "B" },
      existing: { a: "ALocale", stale: "old" },
      sourceKeyOrder: ["a", "b"],
    });
    expect(sync.dict).toEqual({ a: "ALocale", b: "" });
    expect(sync.removed).toEqual(["stale"]);
  });
});
