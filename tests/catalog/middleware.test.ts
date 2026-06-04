import { describe, expect, it, vi } from "vitest";

import { catalogMiddleware } from "../../src/catalog/middleware.js";
import type { TranslateFn } from "../../src/catalog/runtime.js";

describe("catalogMiddleware", () => {
  it("binds only t and lhref", async () => {
    const middleware = catalogMiddleware({
      defaultLocale: "en-US",
      locales: ["en-US", "pt-BR"],
      getDictionary: (locale) => ({
        "nav.home": locale === "pt-BR" ? "Início" : "Home",
      }),
    });
    const next = vi.fn().mockResolvedValue(undefined);
    const context = { currentLocale: "pt-BR", locals: {} as Record<string, unknown> };

    await middleware(context, next);

    expect(Object.keys(context.locals).sort()).toEqual(["lhref", "t"]);
    expect(context.locals.getLocalizedEntry).toBeUndefined();
    expect(context.locals.getLocalizedCollection).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect((context.locals.t as TranslateFn)("nav.home")).toBe("Início");
    expect((context.locals.lhref as (href: string) => string)("/about")).toBe("/pt-BR/about");
  });

  it("falls back to the default catalog, then the literal key", async () => {
    const dictionaries: Record<string, Record<string, string> | undefined> = {
      "en-US": { "nav.home": "Home", "nav.about": "About", greeting: "Hi, {{name}}" },
      "pt-BR": { "nav.home": "Início" },
    };
    const middleware = catalogMiddleware({
      defaultLocale: "en-US",
      locales: ["en-US", "pt-BR"],
      getDictionary: (locale) => dictionaries[locale],
    });
    const context = { currentLocale: "pt-BR", locals: {} as Record<string, unknown> };

    await middleware(context, () => undefined);
    const t = context.locals.t as TranslateFn;

    expect(t("nav.home")).toBe("Início");
    expect(t("nav.about")).toBe("About");
    expect(t("greeting", { name: "Diogo" })).toBe("Hi, Diogo");
    expect(t("missing.key")).toBe("missing.key");
  });
});
