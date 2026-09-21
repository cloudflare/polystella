---
title: Glossaries
description: Per-locale glossary sources that pin do-not-translate terms, preferred translations, and style rules.
aiGenerated: true
---

A glossary tells the translator how to handle terminology that
shouldn't drift between builds. Brand names that stay in English.
Technical terms with a preferred per-locale rendering. Style rules
that apply to a whole locale (formality, capitalisation
conventions).

## File layout

Configured via `glossary.file` in `polystella.config.mjs`:

```js
export default {
  glossary: {
    file: "./i18n/glossary/{locale}.yaml",
  },
};
```

The `{locale}` placeholder is mandatory. PolyStella reads one file
per non-default locale.

## External repositories over HTTP

Use an HTTPS URL template when glossaries live in a GitHub, GitLab,
or other HTTP-hosted directory. PolyStella replaces `{locale}` with
each configured target locale and fetches the files concurrently:

```js
export default {
  glossary: {
    http: {
      url: "https://raw.githubusercontent.com/acme/glossaries/8d13c5a/locales/{locale}.yaml",
    },
  },
};
```

GitLab's equivalent raw URL is
`https://gitlab.com/acme/glossaries/-/raw/8d13c5a/locales/{locale}.yaml`.
Use an immutable commit SHA for reproducible builds. Private repositories
can supply `headers`; the endpoint must return raw YAML rather than a
JSON or base64 API envelope.

For private GitLab repositories, use the API v4 raw-file endpoint with a
`PRIVATE-TOKEN` header. Do not use the web `/-/raw/` route: it can redirect
to the sign-in page, and PolyStella intentionally refuses redirects when
credentials are present.

```js
http: {
  url: "https://gitlab.example.com/api/v4/projects/acme%2Fglossaries/repository/files/locales%2F{locale}.yaml/raw?ref=8d13c5a",
  headers: {
    "PRIVATE-TOKEN": process.env.GITLAB_TOKEN,
  },
}
```

```js
http: {
  url: "https://api.github.com/repos/acme/glossaries/contents/locales/{locale}.yaml?ref=8d13c5a",
  headers: {
    Accept: "application/vnd.github.raw+json",
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  },
}
```

Remote missing files and authentication failures stop the build instead
of silently translating without terminology constraints.

## R2 glossaries

Private R2 buckets use S3-compatible read credentials:

```js
export default {
  glossary: {
    r2: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      bucket: "shared-glossaries",
      key: "locales/{locale}.yaml",
      accessKeyId: process.env.GLOSSARY_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.GLOSSARY_R2_SECRET_ACCESS_KEY,
    },
  },
};
```

Create an R2 API token with object-read permission, then use the generated
**Access Key ID** and **Secret Access Key** shown by Cloudflare. Both values
are required for S3 Signature V4 requests. The Cloudflare API token value
itself cannot replace this credential pair.

The glossary source is mutually exclusive: configure one of `file`,
`inline`, `http`, or `r2`. Source URLs, object keys, and credentials
are not part of the translation cache key; only the validated glossary
content is hashed.

A typical glossary:

```yaml
# i18n/glossary/pt-BR.yaml
version: "2025-04-01"

doNotTranslate:
  - Cloudflare
  - Workers
  - PolyStella

preferredTranslations:
  guide: guia
  tutorial: tutorial

notes: |
  Use Brazilian Portuguese conventions throughout. Numeric
  conventions follow ABNT (e.g. "1,5" not "1.5").

styleRules:
  - category: formality
    instruction: Use the formal "você" address consistently.
  - category: numerals
    instruction: Write small numbers as words (e.g. "três" not "3")
                 when they appear in body prose.
    example: "três experimentos" not "3 experimentos"
```

## How edits propagate

The glossary hash is part of the cache key. When you edit a
glossary file:

1. PolyStella re-hashes the glossary for that locale.
2. Every cached translation for that locale is invalidated.
3. The next build retranslates the affected pages.

In practice the cost is bounded — the hash includes the entire
glossary file content, so adding one term retranslates every page
that mentions that locale, but the translations all still go
through R2 and cache hit on the second build.

## Inline glossaries

For one-off projects or testing:

```js
export default {
  glossary: {
    inline: {
      "pt-BR": {
        doNotTranslate: ["Cloudflare"],
        notes: "Use Brazilian Portuguese.",
      },
    },
  },
};
```

The inline form is identical in semantics to the file form; the
hash includes the inline object's stable JSON serialisation.

## Notes vs style rules

Two free-form text fields with subtly different purposes:

- **`notes`** is a single string. Read by the model once at the
  top of the system prompt. Good for "use this dialect", "the
  audience is academic".
- **`styleRules`** is a list of `{ category, instruction, example? }`
  objects. Each rule reads as a separate constraint to the model
  and is more easily honoured for specific rules. Good for things
  like "always use the formal address", "expand abbreviations".

When in doubt, use `styleRules` — the structure helps the model
follow specific rules more reliably than a long `notes` block.
