import type { AstroIntegration } from "astro";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatDriftIssues, loadAndCheckDrift } from "../i18n/drift.js";
import { DEFAULT_CATALOG_BASE } from "./constants.js";

export interface CatalogAstroOptions {
  /** Project-relative directory containing `<locale>.json` catalog files. */
  baseDir?: string | undefined;
  /** Default: true. Auto-register middleware that binds `Astro.locals.t` and `lhref`. */
  middleware?: boolean | undefined;
  /** Default: true. Check catalog drift during `astro:config:setup`. */
  driftCheck?: boolean | undefined;
  /** Internal URL paths that should not receive a locale prefix from `lhref`. */
  noPrefixUrls?: ReadonlyArray<string> | undefined;
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
}

interface DerivedCatalogI18n {
  defaultLocale: string;
  locales: string[];
}

export function catalogAstro(options: CatalogAstroOptions = {}): AstroIntegration {
  const baseDir = options.baseDir ?? DEFAULT_CATALOG_BASE;
  const middleware = options.middleware ?? true;
  const driftCheck = options.driftCheck ?? true;
  const noPrefixUrls = options.noPrefixUrls ?? [];
  const fallbackToDefault = options.fallbackToDefault ?? true;

  return {
    name: "polystella-catalog",
    hooks: {
      "astro:config:setup": async ({ config, updateConfig, addMiddleware, logger }) => {
        const derived = deriveCatalogI18n(config.i18n);
        const rootDir = fileURLToPath(config.root);
        const cacheDir = fileURLToPath(config.cacheDir);
        const viteBase = toViteRootAbsoluteBase(baseDir);

        const virtualModuleSource = generateCatalogVirtualModuleSource({
          viteBase,
          defaultLocale: derived.defaultLocale,
          locales: derived.locales,
          noPrefixUrls,
          fallbackToDefault,
        });

        updateConfig({
          vite: {
            plugins: [
              {
                name: "polystella:catalog",
                resolveId(id: string) {
                  if (id === "polystella:catalog") return "\0polystella:catalog";
                  return undefined;
                },
                load(id: string) {
                  if (id === "\0polystella:catalog") return virtualModuleSource;
                  return undefined;
                },
              },
            ],
          },
        });

        if (middleware) {
          const middlewareDir = path.resolve(cacheDir, "polystella-catalog");
          await mkdir(middlewareDir, { recursive: true });
          const middlewarePath = path.join(middlewareDir, "middleware.js");
          await writeFile(middlewarePath, generateCatalogMiddlewareSource(), "utf8");
          addMiddleware({ entrypoint: middlewarePath, order: "pre" });
          logger.info("registered catalog middleware (t + lhref)");
        }

        if (driftCheck) {
          const driftResult = await loadAndCheckDrift({
            rootDir,
            baseDir,
            locales: derived.locales,
            defaultLocale: derived.defaultLocale,
          });
          if (!driftResult.ok) {
            throw new Error(
              `[polystella] catalog dictionary drift detected. Every declared locale must have a catalog JSON file with the same key set as the default-locale file (${derived.defaultLocale}.json):\n${formatDriftIssues(
                driftResult.issues,
              )}`,
            );
          }
        }
      },
    },
  };
}

export default catalogAstro;

function deriveCatalogI18n(i18n: unknown): DerivedCatalogI18n {
  if (typeof i18n !== "object" || i18n === null) {
    throw new Error("[polystella] catalog integration requires Astro's `i18n` config.");
  }

  const defaultLocale = (i18n as { defaultLocale?: unknown }).defaultLocale;
  if (typeof defaultLocale !== "string" || defaultLocale.length === 0) {
    throw new Error("[polystella] catalog integration requires `i18n.defaultLocale` to be a non-empty string.");
  }

  const rawLocales = (i18n as { locales?: unknown }).locales;
  if (!Array.isArray(rawLocales) || rawLocales.length === 0) {
    throw new Error("[polystella] catalog integration requires `i18n.locales` to declare at least one locale.");
  }

  const locales: string[] = [];
  for (const entry of rawLocales) {
    const codes = extractLocaleCodes(entry);
    for (const code of codes) {
      if (!locales.includes(code)) locales.push(code);
    }
  }

  if (!locales.includes(defaultLocale)) {
    throw new Error(`[polystella] catalog integration requires i18n.locales to include defaultLocale (${defaultLocale}).`);
  }

  return { defaultLocale, locales };
}

function extractLocaleCodes(entry: unknown): string[] {
  if (typeof entry === "string" && entry.length > 0) return [entry];
  if (typeof entry !== "object" || entry === null) {
    throw new Error("[polystella] catalog integration only supports string locales or object locales with string `path`/`codes`.");
  }

  const codes = (entry as { codes?: unknown }).codes;
  if (Array.isArray(codes) && codes.length > 0 && codes.every((code): code is string => typeof code === "string" && code.length > 0)) {
    return [...codes];
  }

  const localePath = (entry as { path?: unknown }).path;
  if (typeof localePath === "string" && localePath.length > 0) return [localePath];

  throw new Error("[polystella] catalog integration locale objects must include a string `path` or non-empty string `codes` array.");
}

interface CatalogVirtualModuleInput {
  viteBase: string;
  defaultLocale: string;
  locales: ReadonlyArray<string>;
  noPrefixUrls: ReadonlyArray<string>;
  fallbackToDefault: boolean;
}

function generateCatalogVirtualModuleSource(input: CatalogVirtualModuleInput): string {
  const localeToPath: Record<string, string> = {};
  for (const locale of input.locales) {
    localeToPath[locale] = `${input.viteBase}/${locale}.json`;
  }

  return [
    `const modules = import.meta.glob(${JSON.stringify(`${input.viteBase}/*.json`)}, { import: "default" });`,
    `const localeToPath = ${JSON.stringify(localeToPath)};`,
    `export const defaultLocale = ${JSON.stringify(input.defaultLocale)};`,
    `export const locales = ${JSON.stringify(input.locales)};`,
    `export const noPrefixUrls = ${JSON.stringify(input.noPrefixUrls)};`,
    `export const fallbackToDefault = ${JSON.stringify(input.fallbackToDefault)};`,
    "function isDictionary(value) {",
    '  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;',
    '  return Object.values(value).every((entry) => typeof entry === "string");',
    "}",
    "export async function getDictionary(locale) {",
    "  const path = localeToPath[locale];",
    "  if (path === undefined) return undefined;",
    "  const load = modules[path];",
    "  if (load === undefined) return undefined;",
    "  const dict = await load();",
    "  if (!isDictionary(dict)) {",
    "    throw new Error(`[polystella] catalog ${locale}.json must be a JSON object of string values.`);",
    "  }",
    "  return dict;",
    "}",
    "",
  ].join("\n");
}

function generateCatalogMiddlewareSource(): string {
  return [
    `import { catalogMiddleware } from "@cloudflare/polystella/catalog/middleware";`,
    `import { defaultLocale, fallbackToDefault, getDictionary, locales, noPrefixUrls } from "polystella:catalog";`,
    "",
    "export const onRequest = catalogMiddleware({",
    "  defaultLocale,",
    "  locales,",
    "  noPrefixUrls,",
    "  fallbackToDefault,",
    "  getDictionary,",
    "});",
    "",
  ].join("\n");
}

function toViteRootAbsoluteBase(baseDir: string): string {
  const normalized = baseDir.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized.length === 0 || normalized.split("/").includes("..")) {
    throw new Error("[polystella] catalog baseDir must be a project-relative directory inside the project root.");
  }
  return `/${normalized}`;
}
