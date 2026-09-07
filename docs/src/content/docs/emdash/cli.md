---
title: EmDash CLI
description: The polystella binary hosted by @cloudflare/polystella-emdash for check-ui, sync-ui, and translate-ui.
aiGenerated: true
sidebar:
  label: CLI
---

`@cloudflare/polystella-emdash` installs a `polystella` binary that
hosts the catalog subcommands — `check-ui`, `sync-ui`, and
`translate-ui`. They retain the Astro CLI's config and flags.

## Where the handlers live

The command handlers live in the shared `@cloudflare/polystella-cli`
package, which has no standalone binary. Two hosts dispatch them:

- The `polystella` binary from `@cloudflare/polystella-astro`, which
  also hosts `translate` and `audit-mdx`.
- The EmDash CLI host in `@cloudflare/polystella-emdash`, which hosts
  only the catalog commands.

Both dispatch the same exported command handlers, so flag-level
behavior is identical. Run `polystella --help` for the top-level
menu and `polystella <subcommand> --help` for per-subcommand flags.

## The catalog commands

| Command                   | Purpose                                        | Network          |
| ------------------------- | ---------------------------------------------- | ---------------- |
| `polystella check-ui`     | Drift detection over UI-string JSONs           | None (offline)   |
| `polystella sync-ui`      | Mechanical key reconciliation (no AI)          | None (offline)   |
| `polystella translate-ui` | Sync + AI-fill of empty UI-string placeholders | AI provider only |

These are the same commands documented for the Astro CLI. See:

- [check-ui](/cli/check-ui/)
- [sync-ui](/cli/sync-ui/)
- [translate-ui](/cli/translate-ui/)

## Exit codes

The catalog commands share the Astro CLI's exit-code contract:

- `0` — success.
- `1` — configuration error.
- `2` — work failed (drift detected in `check-ui`, pending changes in
  `sync-ui --check`, or token preservation never converged in
  `translate-ui`).

## See also

- [CLI overview](/cli/) — how the catalog commands fit together.
