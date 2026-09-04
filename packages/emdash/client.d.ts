declare module "polystella:catalog" {
  export type TranslateFn = import("@cloudflare/polystella-core/catalog").TranslateFn;

  export const defaultLocale: string;
  export const locales: ReadonlyArray<string>;
  export const fallbackToDefault: boolean;

  export function getDictionary(locale: string): Promise<import("@cloudflare/polystella-core/catalog").CatalogDictionary | undefined>;
  export function buildCatalogTranslator(locale: string | undefined): Promise<TranslateFn>;
  export function buildCatalogHref(locale: string | undefined): (href: string) => string;
}

declare namespace App {
  interface Locals {
    t: import("@cloudflare/polystella-core/catalog").TranslateFn;
    lhref: (href: string) => string;
  }
}
