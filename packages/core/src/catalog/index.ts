export {
  CATALOG_GROUP_TITLE_KEY,
  detectCatalogFormat,
  flattenCatalog,
  formatNestedLocaleFile,
  type CatalogFormat,
  type CatalogSource,
  type FormatNestedLocaleFileOptions,
} from "./flatten.js";

export type CatalogDictionary = Record<string, string>;

export type MaybePromise<T> = T | Promise<T>;

export type GetCatalogDictionary = (locale: string) => MaybePromise<CatalogDictionary | undefined>;

export { formatMessage, messageArgumentNames, MessageSyntaxError, toIcuMessage, type MessageValue, type MessageValues } from "./message.js";
export {
  assertLocaleTags,
  checkLocaleTags,
  formatLocaleTagIssues,
  parseLocaleTags,
  pluralCategories,
  requiredPluralCategories,
  resolveLocaleTag,
  supportedLocaleTag,
  type LocaleTagIssue,
  type LocaleTags,
} from "./locale-tags.js";

import { resolveLocaleTag, supportedLocaleTag, type LocaleTags } from "./locale-tags.js";
import { formatMessage, isPlainText, parseMessage } from "./message.js";

export interface ResolveCatalogTranslationsDeps {
  defaultLocale: string;
  getDictionary: GetCatalogDictionary;
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
  /** Site locale code → BCP 47 tag used for plural rules and number/date formatting. */
  localeTags?: LocaleTags | undefined;
}

export type InterpolateParams = Record<string, string | number | boolean | Date>;

export interface TranslateFn {
  (key: string, params?: InterpolateParams | undefined): string;
  /** The unformatted template for `key` (same fallback chain as `t`), for formatting on the client. */
  raw(key: string): string;
  /** BCP 47 tag the strings are formatted with. */
  readonly locale: string;
}

export interface BuildTranslateFnOptions {
  /** BCP 47 tag for `primary`. Unsupported tags fall back to `fallbackLocale`. */
  locale?: string | undefined;
  /** BCP 47 tag for `fallback`; strings taken from it use its plural rules. */
  fallbackLocale?: string | undefined;
}

const UNDETERMINED_LOCALE = "und";

/** Legacy `{{name}}`-only substitution. Prefer `formatMessage` for catalog strings. */
export function interpolate(template: string, params: InterpolateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (Object.hasOwn(params, key) ? String(params[key]) : match));
}

export function buildTranslateFn(
  primary: CatalogDictionary,
  fallback?: CatalogDictionary | undefined,
  options: BuildTranslateFnOptions = {},
): TranslateFn {
  const fallbackTag = supportedLocaleTag(options.fallbackLocale);
  const primaryTag = supportedLocaleTag(options.locale) ?? fallbackTag;
  const sources: Array<[CatalogDictionary, string | undefined]> = [[primary, primaryTag]];
  if (fallback !== undefined) sources.push([fallback, fallbackTag]);

  const lookup = (key: string): { template: string; tag: string | undefined } | undefined => {
    for (const [dictionary, tag] of sources) {
      const template = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
      if (template !== undefined && isValidMessage(template)) return { template, tag };
    }
    return undefined;
  };

  const translate = (key: string, params?: InterpolateParams | undefined): string => {
    const entry = lookup(key);
    return entry === undefined ? key : formatMessage(entry.template, params ?? {}, entry.tag);
  };
  return Object.assign(translate, {
    raw: (key: string) => lookup(key)?.template ?? key,
    locale: primaryTag ?? UNDETERMINED_LOCALE,
  });
}

/** A `t` that returns every key unchanged; used when no catalog is available. */
export function createPassthroughTranslateFn(locale?: string | undefined): TranslateFn {
  return Object.assign((key: string) => key, {
    raw: (key: string) => key,
    locale: supportedLocaleTag(locale) ?? UNDETERMINED_LOCALE,
  });
}

export async function resolveTranslations(locale: string | undefined, deps: ResolveCatalogTranslationsDeps): Promise<TranslateFn> {
  const effectiveLocale = locale && locale.length > 0 ? locale : deps.defaultLocale;
  const primary = (await deps.getDictionary(effectiveLocale)) ?? {};
  const fallback =
    (deps.fallbackToDefault ?? true) && effectiveLocale !== deps.defaultLocale ? await deps.getDictionary(deps.defaultLocale) : undefined;

  return buildTranslateFn(primary, fallback, {
    locale: resolveLocaleTag(effectiveLocale, deps.localeTags),
    fallbackLocale: resolveLocaleTag(deps.defaultLocale, deps.localeTags),
  });
}

function isValidMessage(template: string): boolean {
  if (isPlainText(template)) return true;
  try {
    parseMessage(template);
    return true;
  } catch {
    return false;
  }
}
