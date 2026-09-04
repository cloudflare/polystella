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
}

interface RuntimeContext {
  currentLocale: string | undefined;
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

  async function getDictionary(locale: string): Promise<CatalogDictionary | undefined> {
    const catalog = config.catalogs.locales[locale];
    if (catalog === undefined) return undefined;

    const overrides = await cachedRuntimeOverrides(
      locale,
      async () => {
        try {
          return await loadOverrides(locale);
        } catch (error) {
          const errorType = error instanceof Error ? error.name : typeof error;
          logError(`[polystella-emdash] runtime overrides unavailable for "${locale}"; using deployed catalog (${errorType})`);
          return {};
        }
      },
      now(),
    );
    return mergeDictionary(catalog.dictionary, overrides);
  }

  async function buildCatalogTranslator(locale: string | undefined): Promise<TranslateFn> {
    return resolveTranslations(locale, {
      defaultLocale: config.catalogs.defaultLocale,
      getDictionary,
      fallbackToDefault: config.fallbackToDefault,
    });
  }

  function buildCatalogHref(locale: string | undefined): (href: string) => string {
    return buildLocalizedHref(locale, config);
  }

  const middleware = async (context: RuntimeContext, next: () => unknown) => {
    context.locals.lhref = buildCatalogHref(context.currentLocale);
    context.locals.t = await buildCatalogTranslator(context.currentLocale);
    return next();
  };

  return { buildCatalogHref, buildCatalogTranslator, getDictionary, middleware };
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
    if (
      href.length === 0 ||
      locale === undefined ||
      locale === config.catalogs.defaultLocale ||
      !Object.hasOwn(config.catalogs.locales, locale) ||
      /^(?:https?:|mailto:|tel:|\/\/|#)/.test(href)
    ) {
      return href;
    }

    for (const configuredLocale of Object.keys(config.catalogs.locales)) {
      if (href === `/${configuredLocale}` || href.startsWith(`/${configuredLocale}/`)) return href;
    }

    const suffixIndex = href.search(/[?#]/);
    const path = suffixIndex === -1 ? href : href.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? "" : href.slice(suffixIndex);
    return `/${locale}/${path.replace(/^\/+/, "")}${suffix}`;
  };
}

export type { TranslateFn };
