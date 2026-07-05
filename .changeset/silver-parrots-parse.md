---
"@cloudflare/polystella": minor
---

Default Markdown and MDX parsing to Satteri, with `markdown.parser: "remark"` available as a legacy compatibility escape hatch. The parser choice is now part of the Markdown/MDX extraction policy hash, so Satteri and Remark outputs use separate cache entries.

This release also updates the package and playground/docs fixtures for Astro 7, reconstructs missing Satteri MDX ESTree metadata needed by static-data extraction and MDX audits, rewrites relative MDX imports only in staged translated files, and refreshes the local staging-cache index version to avoid stale staged MDX output.
