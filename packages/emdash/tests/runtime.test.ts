import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { TranslateFn } from "@cloudflare/polystella-core/catalog";
import { describe, expect, it } from "vitest";

import { polystellaEmdashAstro } from "../src/astro.js";
import type { PolystellaEmdashOptions } from "../src/index.js";
import { invalidateRuntimeOverrides } from "../src/runtime-cache.js";
import { createPolystellaRuntimeMiddleware, type PolystellaRuntimeConfig } from "../src/runtime.js";

function runtimeConfig(): PolystellaRuntimeConfig {
  return {
    catalogs: {
      defaultLocale: "en-US",
      locales: {
        "en-US": { dictionary: { greeting: "Hello", welcome: "Welcome" } },
        "fr-FR": { dictionary: { greeting: "Bonjour" } },
      },
    },
    fallbackToDefault: true,
  };
}

function options(): PolystellaEmdashOptions {
  return {
    provider: {
      kind: "workers-ai-http",
      accountIdEnv: "ACCOUNT_ID_NAME",
      apiTokenEnv: "SECRET_TOKEN_NAME",
    },
    collections: {},
    catalogs: {
      defaultLocale: "en-US",
      locales: {
        "en-US": { dictionary: { greeting: "Hello" }, filePath: "src/i18n/en-US.json" },
        "fr-FR": { dictionary: { greeting: "Bonjour" }, filePath: "src/i18n/fr-FR.json" },
      },
    },
    models: { allowed: ["model-a"], defaults: "model-a" },
  };
}

function translate(locals: Record<string, unknown>): TranslateFn {
  if (typeof locals.t !== "function") throw new Error("missing translation function");
  return locals.t as TranslateFn;
}

function localizedHref(locals: Record<string, unknown>): (href: string) => string {
  if (typeof locals.lhref !== "function") throw new Error("missing localized href function");
  return locals.lhref as (href: string) => string;
}

describe("EmDash Astro runtime", () => {
  it("applies and caches overrides, then invalidates changed locales", async () => {
    invalidateRuntimeOverrides("en-US");
    invalidateRuntimeOverrides("fr-FR");
    const loads = new Map<string, number>();
    let greeting = "Salut";
    const middleware = createPolystellaRuntimeMiddleware(runtimeConfig(), {
      loadOverrides: async (locale) => {
        loads.set(locale, (loads.get(locale) ?? 0) + 1);
        return locale === "fr-FR" ? { greeting } : {};
      },
      now: () => 1,
    });

    const first = { currentLocale: "fr-FR", locals: {} };
    await expect(middleware(first, () => "next")).resolves.toBe("next");
    expect(translate(first.locals)("greeting")).toBe("Salut");
    expect(translate(first.locals)("welcome")).toBe("Welcome");
    expect(localizedHref(first.locals)("/docs?page=2#intro")).toBe("/fr-FR/docs?page=2#intro");

    await middleware({ currentLocale: "fr-FR", locals: {} }, () => undefined);
    expect(loads).toEqual(
      new Map([
        ["fr-FR", 1],
        ["en-US", 1],
      ]),
    );

    greeting = "Coucou";
    invalidateRuntimeOverrides("fr-FR");
    const refreshed = { currentLocale: "fr-FR", locals: {} };
    await middleware(refreshed, () => undefined);
    expect(translate(refreshed.locals)("greeting")).toBe("Coucou");
    expect(loads.get("fr-FR")).toBe(2);
    expect(loads.get("en-US")).toBe(1);
  });

  it("uses deployed catalogs when override storage fails", async () => {
    invalidateRuntimeOverrides("fr-FR");
    const errors: string[] = [];
    let loads = 0;
    const middleware = createPolystellaRuntimeMiddleware(runtimeConfig(), {
      loadOverrides: async () => {
        loads += 1;
        throw new Error("database connection details");
      },
      now: () => 2,
      logError: (message) => errors.push(message),
    });

    const context = { currentLocale: "fr-FR", locals: {} };
    await middleware(context, () => undefined);
    await middleware({ currentLocale: "fr-FR", locals: {} }, () => undefined);

    expect(translate(context.locals)("greeting")).toBe("Bonjour");
    expect(loads).toBe(1);
    expect(errors).toEqual(['[polystella-emdash] runtime overrides unavailable for "fr-FR"; using deployed catalog (Error)']);
    expect(errors[0]).not.toContain("database connection details");
  });

  it("generates pre-middleware without serializing provider credentials", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "polystella-emdash-runtime-"));
    const integration = polystellaEmdashAstro(options());
    const setup = integration.hooks["astro:config:setup"];
    if (setup === undefined) throw new Error("missing config setup hook");
    const middleware: Array<{ entrypoint: string; order: string }> = [];
    let virtualSource = "";

    await (setup as (context: unknown) => Promise<void>)({
      config: { cacheDir: pathToFileURL(`${cacheDirectory}${path.sep}`) },
      updateConfig: (config: { vite?: { plugins?: Array<{ load?: (id: string) => unknown; resolveId?: (id: string) => unknown }> } }) => {
        const plugin = config.vite?.plugins?.[0];
        const id = plugin?.resolveId?.("polystella:catalog");
        if (typeof id === "string") virtualSource = String(plugin?.load?.(id));
      },
      addMiddleware: (entry: { entrypoint: string; order: string }) => middleware.push(entry),
      logger: { info: () => undefined },
    });

    expect(middleware).toHaveLength(1);
    expect(middleware[0]?.order).toBe("pre");
    const source = await readFile(middleware[0]?.entrypoint ?? "", "utf8");
    expect(source).toContain('from "polystella:catalog"');
    expect(virtualSource).toContain("createPolystellaRuntime");
    expect(virtualSource).toContain('"greeting":"Bonjour"');
    expect(virtualSource).not.toContain("SECRET_TOKEN_NAME");
    expect(virtualSource).not.toContain("ACCOUNT_ID_NAME");

    const done = integration.hooks["astro:config:done"];
    if (done === undefined) throw new Error("missing config done hook");
    expect(() => (done as (context: unknown) => void)({ config: { integrations: [{ name: "emdash" }, integration] } })).not.toThrow();
    expect(() => (done as (context: unknown) => void)({ config: { integrations: [integration, { name: "emdash" }] } })).toThrow(
      "add emdash() before polystellaEmdashAstro()",
    );
    expect(() =>
      (done as (context: unknown) => void)({
        config: { integrations: [{ name: "polystella-catalog" }, { name: "emdash" }, integration] },
      }),
    ).toThrow("remove catalogAstro()");
  });
});
