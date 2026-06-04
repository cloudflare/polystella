import type { TranslateFn } from "./runtime.js";

declare global {
  namespace App {
    interface Locals {
      /** Translate a UI catalog key for the visitor's locale. */
      t: TranslateFn;

      /** Locale-prefix an internal URL for the visitor's locale. */
      lhref: (href: string) => string;
    }
  }
}

export {};
