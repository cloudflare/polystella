import type { TranslateFn as CoreTranslateFn } from "@cloudflare/polystella-core/catalog";

export type TranslateFn = CoreTranslateFn;

declare global {
  namespace App {
    interface Locals {
      t: CoreTranslateFn;
      lhref: (href: string) => string;
      buildCatalogTranslator: (locale: string | undefined) => Promise<CoreTranslateFn>;
    }
  }
}
