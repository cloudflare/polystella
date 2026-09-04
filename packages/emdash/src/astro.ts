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
      "astro:config:setup": async ({ config, updateConfig, addMiddleware, logger }) => {
        const middlewareDirectory = path.resolve(fileURLToPath(config.cacheDir), "polystella-emdash-runtime");
        const middlewarePath = path.join(middlewareDirectory, "middleware.mjs");
        const runtimeUrl = new URL("./runtime.js", import.meta.url).href;
        updateConfig({
          vite: {
            plugins: [
              {
                name: "polystella:emdash-catalog",
                resolveId(id: string) {
                  if (id === "polystella:catalog") return "\0polystella:emdash-catalog";
                  return undefined;
                },
                load(id: string) {
                  if (id !== "\0polystella:emdash-catalog") return undefined;
                  return [
                    `import { createPolystellaRuntime } from ${JSON.stringify(runtimeUrl)};`,
                    `const runtime = createPolystellaRuntime(${JSON.stringify(runtimeConfig)});`,
                    `export const defaultLocale = ${JSON.stringify(runtimeConfig.catalogs.defaultLocale)};`,
                    `export const locales = ${JSON.stringify(Object.keys(runtimeConfig.catalogs.locales))};`,
                    `export const fallbackToDefault = ${JSON.stringify(runtimeConfig.fallbackToDefault)};`,
                    "export const buildCatalogHref = runtime.buildCatalogHref;",
                    "export const buildCatalogTranslator = runtime.buildCatalogTranslator;",
                    "export const getDictionary = runtime.getDictionary;",
                    "export const onRequest = runtime.middleware;",
                    "",
                  ].join("\n");
                },
              },
            ],
          },
        });
        await mkdir(middlewareDirectory, { recursive: true });
        await writeFile(middlewarePath, ['export { onRequest } from "polystella:catalog";', ""].join("\n"), "utf8");
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
