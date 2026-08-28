import "./locals.js";

import { resolveLocalizedHref, type LocalizedHrefDeps } from "../runtime/localized-href.js";
import { resolveTranslations, type GetCatalogDictionary, type TranslateFn } from "./runtime.js";

type MinimalContext = {
  currentLocale: string | undefined;
  locals: Record<string, unknown>;
};

export type CatalogMiddleware = (context: MinimalContext, next: () => unknown) => Promise<unknown> | unknown;

export interface CatalogMiddlewareOptions {
  defaultLocale: string;
  /** Full locale set including the default locale. */
  locales: ReadonlyArray<string>;
  getDictionary: GetCatalogDictionary;
  /** Internal URL paths that should not receive a locale prefix. */
  noPrefixUrls?: ReadonlyArray<string> | undefined;
  /** Default: true. Missing visitor-locale keys fall back to the default catalog. */
  fallbackToDefault?: boolean | undefined;
}

export function buildCatalogHref(locale: string | undefined, options: CatalogMiddlewareOptions): (href: string) => string {
  const deps: LocalizedHrefDeps =
    options.noPrefixUrls && options.noPrefixUrls.length > 0
      ? { defaultLocale: options.defaultLocale, locales: options.locales, noPrefixUrls: options.noPrefixUrls }
      : { defaultLocale: options.defaultLocale, locales: options.locales };
  return (href) => resolveLocalizedHref(href, locale, deps);
}

export async function buildCatalogTranslator(locale: string | undefined, options: CatalogMiddlewareOptions): Promise<TranslateFn> {
  try {
    return await resolveTranslations(locale, {
      defaultLocale: options.defaultLocale,
      getDictionary: options.getDictionary,
      fallbackToDefault: options.fallbackToDefault,
    });
  } catch {
    return (key) => key;
  }
}

export function catalogMiddleware(options: CatalogMiddlewareOptions): CatalogMiddleware {
  return async (context, next) => {
    const locale = context.currentLocale;
    context.locals.lhref = buildCatalogHref(locale, options);
    context.locals.t = await buildCatalogTranslator(locale, options);
    return next();
  };
}
