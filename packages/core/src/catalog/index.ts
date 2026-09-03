export type CatalogDictionary = Record<string, string>;

export type MaybePromise<T> = T | Promise<T>;

export type GetCatalogDictionary = (locale: string) => MaybePromise<CatalogDictionary | undefined>;

export interface ResolveCatalogTranslationsDeps {
  defaultLocale: string;
  getDictionary: GetCatalogDictionary;
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
}

export type InterpolateParams = Record<string, string | number | boolean>;

export type TranslateFn = (key: string, params?: InterpolateParams | undefined) => string;

export function interpolate(template: string, params: InterpolateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (Object.hasOwn(params, key) ? String(params[key]) : match));
}

export function buildTranslateFn(primary: CatalogDictionary, fallback?: CatalogDictionary | undefined): TranslateFn {
  return function translate(key, params) {
    const raw = Object.hasOwn(primary, key) ? primary[key] : fallback && Object.hasOwn(fallback, key) ? fallback[key] : undefined;
    if (raw === undefined) return key;
    return params ? interpolate(raw, params) : raw;
  };
}

export async function resolveTranslations(locale: string | undefined, deps: ResolveCatalogTranslationsDeps): Promise<TranslateFn> {
  const effectiveLocale = locale && locale.length > 0 ? locale : deps.defaultLocale;
  const primary = (await deps.getDictionary(effectiveLocale)) ?? {};
  const fallback =
    (deps.fallbackToDefault ?? true) && effectiveLocale !== deps.defaultLocale ? await deps.getDictionary(deps.defaultLocale) : undefined;

  return buildTranslateFn(primary, fallback);
}
