import { defineConfig } from "astro/config";
import icon from "astro-icon";
import nimbus, { defineConfig as defineNimbusConfig } from "nimbus-docs";

const nimbusConfig = defineNimbusConfig({
  site: "https://polystella-docs.pcx-team.workers.dev",
  title: "PolyStella",
  description: "AI-driven content localization for Astro",
  locale: "en",
  github: "https://github.com/cloudflare/polystella",
  editPattern: "https://github.com/cloudflare/polystella/edit/main/docs/{path}",
  socialImageAlt: "PolyStella documentation preview",
  sidebar: {
    items: [
      {
        label: "Getting started",
        items: ["getting-started/install", "getting-started/quick-start", "getting-started/mental-model"],
      },
      {
        label: "Concepts",
        items: [
          "concepts/how-it-works",
          "concepts/r2-cache",
          "concepts/glossaries",
          "concepts/overrides",
          "concepts/mode-boundary",
          "concepts/runtime-bridge",
          "concepts/ai-marker",
        ],
      },
      {
        label: "Configuration",
        items: ["configuration", "configuration/reference"],
      },
      {
        label: "Adapters",
        items: ["adapters/markdown", "adapters/mdx", "adapters/toml", "adapters/custom-loader"],
      },
      {
        label: "Providers",
        items: [
          "providers/workers-ai",
          "providers/anthropic",
          "providers/model-selection",
          "providers/batching",
          "providers/permanent-errors",
        ],
      },
      {
        label: "Routing",
        items: ["routing/shims", "routing/configuration"],
      },
      {
        label: "Runtime API",
        items: ["runtime-api/locals", "runtime-api/middleware", "runtime-api/explicit-imports", "runtime-api/react-hooks"],
      },
      {
        label: "CLI",
        items: ["cli", "cli/translate", "cli/check-ui", "cli/sync-ui", "cli/translate-ui", "cli/audit-mdx"],
      },
      {
        label: "Operations",
        items: ["operations/ci", "operations/branch-dispatch", "operations/preview-isolation"],
      },
      { label: "Cookbook", autogenerate: { directory: "cookbook" } },
      {
        label: "Troubleshooting",
        autogenerate: { directory: "troubleshooting" },
      },
      {
        label: "Reference",
        items: ["reference/exports", "reference/breaking-changes"],
      },
      "roadmap",
    ],
  },
});

export default defineConfig({
  output: "static",
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    icon(),
    nimbus(nimbusConfig, {
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
    }),
  ],
});
