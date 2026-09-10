import {
  CATALOG_GROUP_TITLE_KEY,
  detectCatalogFormat,
  flattenCatalog,
  formatNestedLocaleFile,
  type CatalogDictionary,
  type CatalogSource,
} from "@cloudflare/polystella-core/catalog";

import type { CatalogGroupView } from "./contracts.js";
import type { PolystellaEmdashOptions } from "./index.js";

export type FlatPolystellaEmdashOptions = Omit<PolystellaEmdashOptions, "catalogs"> & {
  catalogs: {
    defaultLocale: string;
    locales: Record<string, { dictionary: CatalogDictionary; filePath: string }>;
  };
};

export function flattenEmdashCatalogs(options: PolystellaEmdashOptions): FlatPolystellaEmdashOptions {
  return {
    ...options,
    catalogs: {
      defaultLocale: options.catalogs.defaultLocale,
      locales: Object.fromEntries(
        Object.entries(options.catalogs.locales).map(([locale, catalog]) => [
          locale,
          { dictionary: flattenCatalog(catalog.dictionary), filePath: catalog.filePath },
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

export function catalogGroupTitles(source: CatalogSource): CatalogGroupView[] {
  return Object.entries(source)
    .flatMap(([key, value]) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
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
): string {
  const output = applyCatalogOverrides(locale, dictionary, overrides);
  return source !== undefined && detectCatalogFormat(source) === "nested"
    ? formatNestedLocaleFile({ dict: output, source, existing: source })
    : `${JSON.stringify(output, null, 2)}\n`;
}
