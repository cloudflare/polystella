import {
  CATALOG_GROUP_TITLE_KEY,
  detectCatalogFormat,
  flattenCatalog,
  formatNestedLocaleFile,
  type CatalogDictionary,
  type CatalogSource,
  type IgnoreKey,
} from "@cloudflare/polystella-core/catalog";
import { PluginRouteError, type StorageCollection } from "emdash";

import type { CatalogGroupView } from "./contracts.js";
import { catalogIgnoreKey, type PolystellaEmdashOptions } from "./server/options.js";

const MAX_OVERRIDE_CHARACTERS = 20_000;
const MAX_TOTAL_OVERRIDE_CHARACTERS = 100_000;

export type FlatPolystellaEmdashOptions = Omit<PolystellaEmdashOptions, "catalogs"> & {
  catalogs: {
    defaultLocale: string;
    locales: Record<string, { dictionary: CatalogDictionary; filePath: string }>;
  };
};

export function flattenEmdashCatalogs(options: PolystellaEmdashOptions): FlatPolystellaEmdashOptions {
  const ignoreKey = catalogIgnoreKey(options);
  return {
    ...options,
    catalogs: {
      defaultLocale: options.catalogs.defaultLocale,
      locales: Object.fromEntries(
        Object.entries(options.catalogs.locales).map(([locale, catalog]) => [
          locale,
          { dictionary: flattenCatalog(catalog.dictionary, ignoreKey), filePath: catalog.filePath },
        ]),
      ),
    },
  };
}

export interface CatalogOverride {
  locale: string;
  key: string;
  value: string;
  updatedAt: string;
  updatedBy: string;
}

export type CatalogOverrideState = "active" | "synced" | "missing";

export function catalogOverrideId(locale: string, key: string): string {
  return JSON.stringify([locale, key]);
}

export function catalogOverrideState(dictionary: CatalogDictionary, override: CatalogOverride): CatalogOverrideState {
  if (!Object.hasOwn(dictionary, override.key)) return "missing";
  return dictionary[override.key] === override.value ? "synced" : "active";
}

export function applyCatalogOverrides(
  locale: string,
  dictionary: CatalogDictionary,
  overrides: readonly CatalogOverride[],
): CatalogDictionary {
  const output = { ...dictionary };
  const seenKeys = new Set<string>();
  for (const override of [...overrides].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
    if (override.locale !== locale) {
      throw new Error(`[polystella-emdash] override locale "${override.locale}" does not match "${locale}"`);
    }
    if (seenKeys.has(override.key)) {
      throw new Error(`[polystella-emdash] duplicate override for key "${override.key}"`);
    }
    seenKeys.add(override.key);
    Object.defineProperty(output, override.key, {
      configurable: true,
      enumerable: true,
      value: override.value,
      writable: true,
    });
  }
  return output;
}

export function catalogGroupTitles(source: CatalogSource, ignoreKey?: IgnoreKey | undefined): CatalogGroupView[] {
  return Object.entries(source)
    .flatMap(([key, value]) => {
      if (value === null || typeof value !== "object" || Array.isArray(value) || ignoreKey?.(key) === true) return [];
      const title = value[CATALOG_GROUP_TITLE_KEY];
      return [{ key, title: typeof title === "string" ? title : null }];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function serializeCatalog(
  locale: string,
  dictionary: CatalogDictionary,
  overrides: readonly CatalogOverride[],
  source?: CatalogSource | undefined,
  ignoreKey?: IgnoreKey | undefined,
): string {
  const output = applyCatalogOverrides(locale, dictionary, overrides);
  if (source !== undefined && detectCatalogFormat(source, ignoreKey) === "nested") {
    return formatNestedLocaleFile({ dict: output, source, existing: source, ignoreKey });
  }
  return `${JSON.stringify(ignoreKey === undefined || source === undefined ? output : withIgnoredEntries(output, source, ignoreKey), null, 2)}\n`;
}

// Ignored entries are not in the flattened dictionary; put them back at their place in the deployed file.
function withIgnoredEntries(output: CatalogDictionary, source: CatalogSource, ignoreKey: IgnoreKey): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const define = (key: string, value: unknown) =>
    Object.defineProperty(merged, key, { configurable: true, enumerable: true, value, writable: true });
  for (const [key, value] of Object.entries(source)) {
    if (ignoreKey(key)) define(key, value);
    else if (Object.hasOwn(output, key)) define(key, output[key]);
  }
  for (const [key, value] of Object.entries(output)) if (!Object.hasOwn(merged, key)) define(key, value);
  return merged;
}

export async function listOverrides(storage: StorageCollection, locale: string): Promise<CatalogOverride[]> {
  const overrides: CatalogOverride[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.query({ where: { locale }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) {
      const override = parseOverride(item.data);
      if (override.locale !== locale) throw PluginRouteError.internal("catalog override locale index is invalid");
      overrides.push(override);
    }
    if (!page.hasMore) break;
    if (page.cursor === undefined) throw PluginRouteError.internal("override pagination cursor is missing");
    cursor = page.cursor;
  } while (true);
  return overrides.sort((left, right) => left.key.localeCompare(right.key));
}

export function usableOverrides(
  options: { catalogs: { defaultLocale: string; locales: Record<string, { dictionary: Record<string, string> }> } },
  locale: string,
  overrides: readonly CatalogOverride[],
): CatalogOverride[] {
  const source = options.catalogs.locales[options.catalogs.defaultLocale]?.dictionary;
  const catalog = options.catalogs.locales[locale]?.dictionary;
  if (source === undefined || catalog === undefined) throw PluginRouteError.internal("catalog configuration is unavailable");
  const allowed = new Set([...Object.keys(source), ...Object.keys(catalog)]);
  const maxCharacters = overrideCharacterLimit(source, catalog);
  return overrides.filter((override) => allowed.has(override.key) && override.value.length <= maxCharacters);
}

export function overrideCharacterLimit(source: Record<string, string>, catalog: Record<string, string>): number {
  const keyCount = new Set([...Object.keys(source), ...Object.keys(catalog)]).size;
  return Math.min(MAX_OVERRIDE_CHARACTERS, Math.floor(MAX_TOTAL_OVERRIDE_CHARACTERS / Math.max(1, keyCount)));
}

export function parseOverride(value: unknown): CatalogOverride {
  const record = readStoredRecord(value, "catalog override");
  return {
    locale: readStoredString(record.locale, "catalog override locale"),
    key: readStoredString(record.key, "catalog override key"),
    value: readStoredString(record.value, "catalog override value", true),
    updatedAt: readStoredString(record.updatedAt, "catalog override updatedAt"),
    updatedBy: readStoredString(record.updatedBy, "catalog override updatedBy"),
  };
}

function readStoredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw PluginRouteError.internal(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function readStoredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw PluginRouteError.internal(`${label} is invalid`);
  return value;
}
