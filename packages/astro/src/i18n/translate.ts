/**
 * Runtime UI-string translator.
 *
 * `getTranslations(locale)` returns a `t(key, params?)` bound to the
 * visitor's locale. Reads from the `i18n` content collection.
 *
 * Resolution on missing keys:
 *   1. Requested-locale dictionary (the steady-state hit; drift
 *      detection ensures every locale has the same key set).
 *   2. Default-locale dictionary (defensive — should never fire
 *      after a clean drift-checked build).
 *   3. The key itself, returned as a string. Last-resort fallback so
 *      a page never crashes on a missing key.
 *
 * Interpolation uses `{{name}}` placeholders. Unknown placeholders
 * pass through unchanged so authoring typos surface in the rendered
 * page rather than silently rendering empty.
 *
 * The pure helpers are exported so tests can pin behaviour without
 * going through Astro's content layer.
 */

import { buildTranslateFn, type TranslateFn } from "@cloudflare/polystella-core/catalog";

export { buildTranslateFn, interpolate, type InterpolateParams, type TranslateFn } from "@cloudflare/polystella-core/catalog";

/**
 * Astro-content shape we need at page-render time. Structural so
 * tests can pass synthetic implementations.
 */
export type GetI18nEntry = (locale: string) => Promise<{ data: Record<string, string> } | undefined>;

export interface UseTranslationsDeps {
  defaultLocale: string;
  getI18nEntry: GetI18nEntry;
}

/**
 * Pure core of `getTranslations`. `locale === undefined` is treated
 * as `defaultLocale` so the homepage (where `Astro.currentLocale`
 * may be unset under `prefixDefaultLocale: false`) gets the default
 * dictionary.
 */
export async function resolveTranslations(locale: string | undefined, deps: UseTranslationsDeps): Promise<TranslateFn> {
  const effectiveLocale = locale ?? deps.defaultLocale;
  const primaryEntry = await deps.getI18nEntry(effectiveLocale);
  const primary = primaryEntry?.data ?? {};

  // Fallback only meaningful when the requested locale isn't the default.
  let fallback: Record<string, string> | undefined;
  if (effectiveLocale !== deps.defaultLocale) {
    const fallbackEntry = await deps.getI18nEntry(deps.defaultLocale);
    fallback = fallbackEntry?.data;
  }

  return buildTranslateFn(primary, fallback);
}
