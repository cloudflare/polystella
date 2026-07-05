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
- Static MDX arrays/objects with likely user-facing copy that are not
  configured or annotated for translation.
- Unsupported static-data syntax inside likely/content-configured data,
  such as spreads, computed keys, template literals, and conditionals.
- Custom component children that look like visible copy but the
  component is not configured with `children: true`.

The command is warn-only. Use the findings to add a component rule,
import a recipe, annotate static page data, move dynamic strings into
a catalog, or add an ignore comment when the string is intentionally
not translated.

## Ignore Comments

Use `@polystella ignore` or `polystella-ignore` to suppress findings
for the comment line and following contiguous non-blank block:

```mdx
{/* @polystella ignore */}

<Callout title="Machine-only title" />
```

For static MDX data:

```mdx
// @polystella ignore
export const machineData = [{ label: "Internal code name" }];
```
