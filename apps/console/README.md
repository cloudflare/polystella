# Translation Console App

Private workspace app containing the Translation Agent's current React
translation UI and its static-assets Worker. This is the existing UI, not a new
administrative console.

It calls the [server app](../server/) only through `/api/translate` and has no
workspace dependency on it. See the server README for migration state and how
paths map from the GitLab repository.

## Commands

```bash
pnpm --filter polystella-console typecheck
pnpm --filter polystella-console build
pnpm --filter polystella-console dev
```

Vite serves the UI at `http://localhost:5173` and proxies `/api` to the server
at `http://localhost:8787`. Run `pnpm dev:apps` from the repository root to
start both.

`evaluation-results.json` and `token-usage.json` are placeholders for the
evaluation heatmap. Real evaluation data is private and is not committed.
