---
title: Install
description: How to install PolyStella in your Astro project.
---

PolyStella is an Astro integration. It runs at build time, talks to
Cloudflare R2 for caching, and stays out of your hosting layer
entirely — the output is regular static-Astro bytes.

## Compatibility

- **Astro 6.0+** as a peer dependency.
- **Node 20+** for the standalone `polystella` CLI.
- **Cloudflare R2** for build cache. No other storage backend is
  supported today.
- **Workers AI** or **Anthropic** as the translation provider.
  Adding a new provider is a discrete extension; see the [provider
  pages](/providers/workers-ai/) for the current contract.

## Installation

PolyStella isn't on npm yet. Install from GitHub:

```bash
pnpm add github:cloudflare/polystella#vX.Y.Z
```

An npm publish will follow once the API stabilises. See the
[roadmap](/roadmap/) for the latest status.

## After install

Continue with the [quick start](/getting-started/quick-start/) for
the four-file project setup, or read the [mental model](/getting-started/mental-model/)
first if you'd rather understand what's about to happen.
