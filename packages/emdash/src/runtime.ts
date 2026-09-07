import { resolveTranslations, type CatalogDictionary, type TranslateFn } from "@cloudflare/polystella-core/catalog";
import { getPluginSetting, PluginStorageRepository } from "emdash";
import { getDb } from "emdash/runtime";

import { applyCatalogOverrides } from "./catalog.js";
import { POLYSTELLA_PLUGIN_ID } from "./contracts.js";
import { cachedRuntimeOverrides } from "./runtime-cache.js";
import { listOverrides, usableOverrides } from "./routes.js";
import { runtimeOverrideSettingKey } from "./settings.js";

interface RuntimeCatalog {
  dictionary: CatalogDictionary;
}

export interface PolystellaRuntimeConfig {
  catalogs: {
    defaultLocale: string;
    locales: Record<string, RuntimeCatalog>;
  };
  fallbackToDefault: boolean;
  localePaths?: Record<string, string> | undefined;
  prefixDefaultLocale?: boolean | undefined;
}

interface RuntimeContext {
  currentLocale: string | undefined;
  isPrerendered?: boolean | undefined;
  locals: Record<string, unknown>;
}

export interface PolystellaRuntimeDependencies {
  loadOverrides?: ((locale: string) => Promise<Record<string, string>>) | undefined;
  now?: (() => number) | undefined;
  logError?: ((message: string) => void) | undefined;
}

export function createPolystellaRuntime(config: PolystellaRuntimeConfig, dependencies: PolystellaRuntimeDependencies = {}) {
  const loadOverrides = dependencies.loadOverrides ?? ((locale: string) => loadStoredOverrides(config, locale));
  const now = dependencies.now ?? Date.now;
  const logError = dependencies.logError ?? ((message: string) => console.error(message));
  const injectedCacheScope = {};

  function deployedDictionary(locale: string): CatalogDictionary | undefined {
    if (!Object.hasOwn(config.catalogs.locales, locale)) return undefined;
    return config.catalogs.locales[locale]?.dictionary;
  }

  async function getDictionary(locale: string): Promise<CatalogDictionary | undefined> {
    const dictionary = deployedDictionary(locale);
    if (dictionary === undefined) return undefined;

    let cacheScope = injectedCacheScope;
    if (dependencies.loadOverrides === undefined) {
      try {
        cacheScope = await getDb();
      } catch (error) {
        logStorageError(locale, error, logError);
        return dictionary;
      }
    }

    const overrides = await cachedRuntimeOverrides(
      cacheScope,
      locale,
      async () => {
        try {
          return await loadOverrides(locale);
        } catch (error) {
          logStorageError(locale, error, logError);
          return {};
        }
      },
      now(),
    );
    return mergeDictionary(dictionary, overrides);
  }

  async function resolveCatalogTranslator(
    locale: string | undefined,
    getCatalogDictionary: (locale: string) => Promise<CatalogDictionary | undefined> | CatalogDictionary | undefined,
  ): Promise<TranslateFn> {
    return resolveTranslations(locale, {
      defaultLocale: config.catalogs.defaultLocale,
      getDictionary: getCatalogDictionary,
      fallbackToDefault: config.fallbackToDefault,
    });
  }

  function buildCatalogTranslator(locale: string | undefined): Promise<TranslateFn> {
    return resolveCatalogTranslator(locale, getDictionary);
  }

  function buildCatalogHref(locale: string | undefined): (href: string) => string {
    return buildLocalizedHref(locale, config);
  }

  const middleware = async (context: RuntimeContext, next: () => unknown) => {
    const getCatalogDictionary = context.isPrerendered ? deployedDictionary : getDictionary;
    context.locals.lhref = buildCatalogHref(context.currentLocale);
    context.locals.buildCatalogTranslator = (locale: string | undefined) => resolveCatalogTranslator(locale, getCatalogDictionary);
    context.locals.t = await resolveCatalogTranslator(context.currentLocale, getCatalogDictionary);
    return next();
  };

  return { buildCatalogHref, buildCatalogTranslator, getDictionary, middleware };
}

function logStorageError(locale: string, error: unknown, logError: (message: string) => void): void {
  const errorType = error instanceof Error ? error.name : typeof error;
  logError(`[polystella-emdash] runtime overrides unavailable for "${locale}"; using deployed catalog (${errorType})`);
}

export function createPolystellaRuntimeMiddleware(
  config: PolystellaRuntimeConfig,
  dependencies: PolystellaRuntimeDependencies = {},
): (context: RuntimeContext, next: () => unknown) => Promise<unknown> {
  return createPolystellaRuntime(config, dependencies).middleware;
}

async function loadStoredOverrides(config: PolystellaRuntimeConfig, locale: string): Promise<Record<string, string>> {
  if ((await getPluginSetting<unknown>(POLYSTELLA_PLUGIN_ID, runtimeOverrideSettingKey(locale))) !== true) return {};

  const db = await getDb();
  const storage = new PluginStorageRepository<unknown>(db, POLYSTELLA_PLUGIN_ID, "catalog_overrides", ["locale"]);
  const overrides = usableOverrides(config, locale, await listOverrides(storage, locale));
  return applyCatalogOverrides(locale, {}, overrides);
}

function mergeDictionary(dictionary: CatalogDictionary, overrides: Record<string, string>): CatalogDictionary {
  const merged = { ...dictionary };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") throw new Error("runtime override values must be strings");
    Object.defineProperty(merged, key, { configurable: true, enumerable: true, value, writable: true });
  }
  return merged;
}

function buildLocalizedHref(locale: string | undefined, config: PolystellaRuntimeConfig): (href: string) => string {
  return (href) => {
    const localePath = locale === undefined ? undefined : (config.localePaths?.[locale] ?? locale);
    if (
      href.length === 0 ||
      locale === undefined ||
      localePath === undefined ||
      (locale === config.catalogs.defaultLocale && config.prefixDefaultLocale !== true) ||
      !Object.hasOwn(config.catalogs.locales, locale) ||
      /^(?:https?:|mailto:|tel:|\/\/|#)/.test(href)
    ) {
      return href;
    }

    const configuredPaths = config.localePaths === undefined ? Object.keys(config.catalogs.locales) : Object.values(config.localePaths);
    for (const configuredPath of configuredPaths) {
      if (href === `/${configuredPath}` || href.startsWith(`/${configuredPath}/`)) return href;
    }

    const suffixIndex = href.search(/[?#]/);
    const path = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? "" : href.slice(suffixIndex);
    return `/${localePath}/${path.replace(/^\/+/, "")}${suffix}`;
  };
}

export type { TranslateFn };
