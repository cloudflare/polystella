// @ts-check
import mdx from "@astrojs/mdx";
import polystella from "@cloudflare/polystella";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://polystella-mdx-jsx-playground.local",
  integrations: [
    mdx(),
    polystella({
      sourceDir: "./src/content",
      include: ["**/*.{md,mdx}"],
      markdown: {
        keys: {
          "docs/**": ["title", "description"],
        },
        urls: {
          "docs/**": ["canonicalUrl"],
        },
        contextKeys: {
          "docs/**": ["title", "description"],
        },
        mdx: {
          recipes: [
            {
              components: {
                Badge: { children: true },
                Callout: { children: true, props: ["title"] },
                FeatureCard: { props: ["title", "description"] },
                FeatureGrid: { props: [] },
                Icon: { props: ["label"] },
              },
              data: {
                "docs/**": {
                  blockFeatures: ["[].title", "[].description"],
                  features: ["[].title", "[].description"],
                },
              },
            },
          ],
        },
      },
      dryRun: true,
      verbose: true,
    }),
  ],
  i18n: {
    defaultLocale: "en-US",
    locales: ["en-US", "pt-BR", "fr-FR"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
