import type { CatalogDictionary } from "@cloudflare/polystella-core/catalog";

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

export function serializeCatalog(locale: string, dictionary: CatalogDictionary, overrides: readonly CatalogOverride[]): string {
  return `${JSON.stringify(applyCatalogOverrides(locale, dictionary, overrides), null, 2)}\n`;
}
