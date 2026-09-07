import type { TranslateFn } from "@cloudflare/polystella-core/catalog";
import type { AstroIntegration } from "astro";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validatePolystellaEmdashOptions, type PolystellaEmdashOptions } from "./index.js";
import type { PolystellaRuntimeConfig } from "./runtime.js";

declare global {
  namespace App {
    interface Locals {
      t: TranslateFn;
      lhref: (href: string) => string;
      buildCatalogTranslator: (locale: string | undefined) => Promise<TranslateFn>;
    }
  }
}

export interface PolystellaEmdashAstroOptions {
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
}

export function polystellaEmdashAstro(
  options: PolystellaEmdashOptions,
  runtimeOptions: PolystellaEmdashAstroOptions = {},
): AstroIntegration {
  validatePolystellaEmdashOptions(options);
  const runtimeConfig: PolystellaRuntimeConfig = {
    catalogs: {
      defaultLocale: options.catalogs.defaultLocale,
      locales: Object.fromEntries(
        Object.entries(options.catalogs.locales).map(([locale, catalog]) => [
          locale,
          { dictionary: Object.fromEntries(Object.entries(catalog.dictionary)) },
        ]),
      ),
    },
    fallbackToDefault: runtimeOptions.fallbackToDefault ?? true,
  };

  return {
    name: "polystella-emdash-runtime",
    hooks: {
      "astro:config:setup": async ({ config, addMiddleware, logger }) => {
        const routing = validateCatalogI18n(config.i18n, runtimeConfig);
        const configuredRuntime = { ...runtimeConfig, ...routing };
        const middlewareDirectory = path.resolve(fileURLToPath(config.cacheDir), "polystella-emdash-runtime");
        const middlewarePath = path.join(middlewareDirectory, "middleware.mjs");
        await mkdir(middlewareDirectory, { recursive: true });
        await writeFile(
          middlewarePath,
          [
            `import { createPolystellaRuntimeMiddleware } from ${JSON.stringify(new URL("./runtime.js", import.meta.url).href)};`,
            `export const onRequest = createPolystellaRuntimeMiddleware(${JSON.stringify(configuredRuntime)});`,
            "",
          ].join("\n"),
          "utf8",
        );
        addMiddleware({ entrypoint: middlewarePath, order: "pre" });
        logger.info("registered runtime catalog middleware (t + lhref + EmDash overrides)");
      },
      "astro:config:done": ({ config }) => {
        if (config.integrations.some((integration) => integration.name === "polystella-catalog")) {
          throw new Error("[polystella-emdash] remove catalogAstro(); polystellaEmdashAstro() replaces it");
        }
        const emdashIndex = config.integrations.findIndex((integration) => integration.name === "emdash");
        const runtimeIndex = config.integrations.findIndex((integration) => integration.name === "polystella-emdash-runtime");
        if (emdashIndex === -1 || runtimeIndex < emdashIndex) {
          throw new Error("[polystella-emdash] add emdash() before polystellaEmdashAstro() in Astro integrations");
        }
      },
    },
  };
}

function validateCatalogI18n(
  i18n: unknown,
  runtimeConfig: PolystellaRuntimeConfig,
): Pick<PolystellaRuntimeConfig, "localePaths" | "prefixDefaultLocale"> {
  if (typeof i18n !== "object" || i18n === null) {
    throw new Error("[polystella-emdash] polystellaEmdashAstro() requires Astro's i18n config");
  }

  const defaultLocale = (i18n as { defaultLocale?: unknown }).defaultLocale;
  if (defaultLocale !== runtimeConfig.catalogs.defaultLocale) {
    throw new Error("[polystella-emdash] Astro i18n.defaultLocale must match catalogs.defaultLocale");
  }

  const entries = (i18n as { locales?: unknown }).locales;
  const localeEntries = Array.isArray(entries) ? entries.flatMap(extractLocalePaths) : [];
  const localePaths = Object.fromEntries(localeEntries);
  const astroLocales = Object.keys(localePaths);
  const uniqueAstroLocales = new Set(astroLocales);
  const catalogLocales = Object.keys(runtimeConfig.catalogs.locales);
  if (
    !Array.isArray(entries) ||
    localeEntries.length !== astroLocales.length ||
    uniqueAstroLocales.size !== catalogLocales.length ||
    catalogLocales.some((locale) => !uniqueAstroLocales.has(locale))
  ) {
    throw new Error("[polystella-emdash] Astro i18n locales must match configured catalog locales");
  }

  const routing = (i18n as { routing?: unknown }).routing;
  const prefixDefaultLocale =
    typeof routing === "object" && routing !== null && (routing as { prefixDefaultLocale?: unknown }).prefixDefaultLocale === true;
  return { localePaths, prefixDefaultLocale };
}

function extractLocalePaths(entry: unknown): Array<[string, string]> {
  if (typeof entry === "string" && entry.length > 0) return [[entry, entry]];
  if (typeof entry !== "object" || entry === null) return [];

  const codes = (entry as { codes?: unknown }).codes;
  const localePath = (entry as { path?: unknown }).path;
  if (
    typeof localePath !== "string" ||
    localePath.length === 0 ||
    !Array.isArray(codes) ||
    codes.length === 0 ||
    !codes.every((code): code is string => typeof code === "string" && code.length > 0)
  ) {
    return [];
  }
  return codes.map((code) => [code, localePath]);
}
