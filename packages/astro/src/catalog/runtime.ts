import { buildTranslateFn, interpolate, type InterpolateParams, type TranslateFn } from "../i18n/translate.js";

export { buildTranslateFn, interpolate, type InterpolateParams, type TranslateFn };

export type CatalogDictionary = Record<string, string>;

export type MaybePromise<T> = T | Promise<T>;

export type GetCatalogDictionary = (locale: string) => MaybePromise<CatalogDictionary | undefined>;

export interface ResolveCatalogTranslationsDeps {
  defaultLocale: string;
  getDictionary: GetCatalogDictionary;
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
}

export async function resolveTranslations(locale: string | undefined, deps: ResolveCatalogTranslationsDeps): Promise<TranslateFn> {
  const effectiveLocale = locale && locale.length > 0 ? locale : deps.defaultLocale;
  const primary = (await deps.getDictionary(effectiveLocale)) ?? {};

  let fallback: CatalogDictionary | undefined;
  if ((deps.fallbackToDefault ?? true) && effectiveLocale !== deps.defaultLocale) {
    fallback = await deps.getDictionary(deps.defaultLocale);
  }

  return buildTranslateFn(primary, fallback);
}
