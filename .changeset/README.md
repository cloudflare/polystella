# Changesets

This directory tracks pending version + changelog entries between
releases. Each PR that user-visibly changes the package adds one
markdown file here describing the change.

## Adding a changeset

```bash
pnpm changeset
```

…which interactively asks:

- **Which packages are affected?** Just `@cloudflare/polystella` for most
  changes. The `polystella-docs` site is ignored (`ignore` list in
  `config.json`).
- **Is the change major / minor / patch?** Pre-1.0, "major" stays
  reserved for 1.0; bump minor for breaking changes within 0.x,
  patch otherwise.
- **A summary.** One-liner that lands in `CHANGELOG.md`.

The result is a small markdown file in this directory. Commit it
with the PR.

## What happens at release time

Pending changesets are consumed by the versioning step for a release.
That step:

- Bumps `package.json`'s version per the changeset severities.
- Updates `CHANGELOG.md` with each changeset's summary.
- Deletes the consumed changeset files.

Publishing is wired separately: pushing a `v*` tag runs
`.github/workflows/publish.yml`, which uses npm Trusted Publishing and
must not use an npm token secret.
