/**
 * Ambient type declarations for PolyStella's virtual modules.
 *
 * Consumers should add the following triple-slash reference to their
 * `src/env.d.ts` (or any other ambient declaration file) so editors
 * and `tsc` can resolve `polystella:runtime-config` imports:
 *
 *     /// <reference types="@cloudflare/polystella/client" />
 *
 * Mirrors Astro's own `astro/client` pattern.
 */

declare module "polystella:runtime-config" {
  /** Source/canonical locale, mirrored from `config.i18n.defaultLocale`. */
  export const defaultLocale: string;

  /**
   * Full locale set including the default. Used by `localizedHref`
   * for its idempotency check (so a URL already prefixed with any
   * declared locale is left alone on re-render).
   */
  export const locales: ReadonlyArray<string>;

  /**
   * Behaviour on cross-locale miss in `getLocalizedEntry` for sources
   * WITHOUT `noTranslate: true`:
   * `"default-locale"` returns source content with `isLocalized: false`,
   * `"skip"` returns `undefined` so the page 404s.
   */
  export const fallback: "default-locale" | "skip";

  /**
   * Behaviour on cross-locale miss for sources WITH
   * `noTranslate: true` in their frontmatter. Takes precedence over
   * `fallback` when the flag is set:
   * `"fallback"` returns source content with `isLocalized: false`,
   * `"404"` returns `undefined`.
   */
  export const noTranslateBehavior: "fallback" | "404";

  /**
   * Operator-declared internal URL paths that should NOT receive a
   * locale prefix. Picomatch globs against the URL path (after
   * splitting query/fragment). Used by `localizedHref` for parity
   * with the build-time link rewriter.
   */
  export const noPrefixUrls: ReadonlyArray<string>;

  /**
   * Resolved integration mode. The runtime middleware reads this
   * to decide whether to install polystella's `Astro.locals.t`
   * (standalone / auto) or defer to Starlight's (starlight).
   */
  export const mode: "auto" | "standalone" | "starlight";
}

declare module "polystella:catalog" {
  /** Source/canonical locale, mirrored from `config.i18n.defaultLocale`. */
  export const defaultLocale: string;

  /** Full locale set including the default locale. */
  export const locales: ReadonlyArray<string>;

  /** Internal URL paths that should not receive a locale prefix. */
  export const noPrefixUrls: ReadonlyArray<string>;

  /** Whether missing visitor-locale keys fall back to the default catalog. */
  export const fallbackToDefault: boolean;

  /** Load a flat string dictionary for a locale from the catalog integration. */
  export function getDictionary(locale: string): Promise<import("@cloudflare/polystella/catalog").CatalogDictionary | undefined>;
}
