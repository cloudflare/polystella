// @ts-check
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { polystellaEmdash } from "@cloudflare/polystella-emdash";
import { polystellaEmdashAstro } from "@cloudflare/polystella-emdash/astro";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

import { defaultLocale, locales } from "./locales.mjs";
import { createPolystellaOptions, useAiBinding } from "./polystella.options.mjs";

const polystellaOptions = createPolystellaOptions("cloudflare");

export default defineConfig({
  output: "server",
  // The AI binding is always remote; only connect to it when it is the provider.
  adapter: cloudflare({ remoteBindings: useAiBinding }),
  integrations: [
    react(),
    emdash({
      database: d1({ binding: "DB", session: "auto", coalesce: true }),
      storage: r2({ binding: "MEDIA" }),
      plugins: [polystellaEmdash(polystellaOptions)],
    }),
    polystellaEmdashAstro(polystellaOptions),
  ],
  i18n: { defaultLocale, locales },
  devToolbar: { enabled: false },
});
