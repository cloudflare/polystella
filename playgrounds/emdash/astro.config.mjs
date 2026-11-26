// @ts-check
import node from "@astrojs/node";
import react from "@astrojs/react";
import { polystellaEmdash } from "@cloudflare/polystella-emdash";
import { polystellaEmdashAstro } from "@cloudflare/polystella-emdash/astro";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

import { defaultLocale, locales } from "./locales.mjs";
import { createPolystellaOptions } from "./polystella.options.mjs";

const polystellaOptions = createPolystellaOptions("node");

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [
    react(),
    emdash({
      database: sqlite({ url: "file:./data.db" }),
      storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
      plugins: [polystellaEmdash(polystellaOptions)],
    }),
    polystellaEmdashAstro(polystellaOptions),
  ],
  i18n: { defaultLocale, locales },
  devToolbar: { enabled: false },
});
