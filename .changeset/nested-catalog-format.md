---
"@cloudflare/polystella-core": minor
"@cloudflare/polystella-astro": minor
"@cloudflare/polystella-cli": minor
---

Support nested catalog JSON format alongside the flat string→string format. Nested groups are flattened to dotted keys so `t("site.title")` works identically in both formats; an optional `i18n_group_title` key per group is metadata for tooling and is excluded from translation keys, drift checks, and AI translation. Format is auto-detected per file; all locale files must match the default locale's format. Drift detection, `sync-ui`, `translate-ui`, and the content-collection `i18nSchema` all handle nested files.
