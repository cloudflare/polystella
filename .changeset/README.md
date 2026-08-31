# Changesets

This directory tracks pending version + changelog entries between
releases. Each PR that user-visibly changes a public package adds one
markdown file here describing the change.

## Adding a changeset

```bash
pnpm changeset
```

…which interactively asks:

- **Which packages are affected?** Select every package changed by the PR:
  `@cloudflare/polystella-core`, `@cloudflare/polystella-adapters`,
  `@cloudflare/polystella-providers`, `@cloudflare/polystella`, and/or
  `@cloudflare/polystella-astro`. Astro and the compatibility package form a
  fixed group; core, adapters, and providers are versioned independently. The
  private root and `polystella-docs` are not released.
- **Is the change major / minor / patch?** Pre-1.0, "major" stays
  reserved for 1.0; bump minor for breaking changes within 0.x,
  patch otherwise.
- **A summary.** One-liner that lands in the affected package changelogs.

The result is a small markdown file in this directory. Commit it
with the PR.

## What happens at release time

Pending changesets are consumed by the versioning step for a release.
That step:

- Bumps affected independent packages and both packages in the Astro fixed group.
- Updates the package-local `CHANGELOG.md` files.
- Deletes the consumed changeset files.

Publishing is automated from `.github/workflows/release.yml`. Merging
the generated release PR back to `main` publishes to npm via Trusted
Publishing, so routine releases must not use an npm token secret.
