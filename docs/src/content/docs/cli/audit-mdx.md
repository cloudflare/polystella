---
title: polystella audit-mdx
description: "polystella audit-mdx — offline MDX extraction audit."
---

`audit-mdx` scans configured `.mdx` sources for likely missed
translation surfaces. It runs offline: no AI provider, no R2, no
staging writes.

```sh
polystella audit-mdx [flags]
```

## Flags

| Flag            | Purpose                                                              |
| --------------- | -------------------------------------------------------------------- |
| `--file <glob>` | Replace configured include globs with one `sourceDir`-relative glob. |
| `--json`        | Emit structured JSON for tooling.                                    |
| `--help`        | Print command help.                                                  |

## What It Reports

- Static string props on custom components that are not configured
  in `markdown.mdx.components`.
- JSX expression props, which content translation intentionally does
  not evaluate.
- Static HTML attributes that look user-facing but are not in the
  HTML attribute allowlist.

The command is warn-only. Use the findings to add a component rule,
import a recipe, annotate static page data, move dynamic strings into
a catalog, or add an ignore once that exists for the audit surface.
