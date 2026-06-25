---
title: MDX adapter
description: "Translating .mdx files — JSX, props, static data, and limits."
---

The MDX adapter reuses the Markdown adapter but parses `.mdx` with
`remark-mdx`, so imports, exports, JSX, and expressions are recognised
as first-class syntax instead of raw Markdown text.

## What Translates Automatically

- Markdown prose in paragraphs, headings, lists, and table cells.
- Markdown prose nested inside block-level JSX wrappers.
- Inline JSX children through placeholders, so the model sees the
  full sentence but not raw component syntax.
- Frontmatter scalars configured through `markdown.keys`.
- Safe lowercase HTML attributes: `alt`, `title`, `aria-label`, and
  `placeholder`.

Example inline JSX input:

```mdx
This feature is <Badge>new</Badge> and experimental.
```

The translator sees a protected segment like:

```text
This feature is <ph id="0">new</ph> and experimental.
```

The placeholder may move in the translated sentence, then PolyStella
restores the original JSX wrapper.

## Explicit MDX Rules

Custom component props are not translated by default. Configure the
component API explicitly:

```js
export default {
  markdown: {
    mdx: {
      components: {
        Callout: { children: true, props: ["title"] },
        Hero: { props: ["headline", "subheadline", "ctaLabel"] },
      },
    },
  },
};
```

Page-local static arrays and objects can be configured centrally:

```js
export default {
  markdown: {
    mdx: {
      data: {
        "docs/**": {
          features: ["[].title", "[].description"],
        },
      },
    },
  },
};
```

Or locally with annotations:

```mdx
export const cards = /** @polystella translate title, description */ [
  { title: "Fast setup", description: "Start in minutes.", icon: "rocket" },
];
```

The annotation marks the next static object/array literal. It does
not execute a function or evaluate runtime code.

## Recipes

Recipes are reusable MDX rule fragments for frameworks or design
systems:

```js
import { starlightRecipe } from "@cloudflare/polystella/recipes/starlight";

export default {
  markdown: {
    mdx: {
      recipes: [starlightRecipe()],
    },
  },
};
```

Project config overrides recipe rules. Inline annotations are the
strongest signal because they sit next to the content.

## What Stays Verbatim

- Imports and exports, except static data string fields selected by
  `markdown.mdx.data` or annotations.
- Code blocks and fences.
- Machine props such as `type`, `variant`, `icon`, `class`, `id`,
  `href`, and `src`, unless you explicitly configure otherwise.
- Expression props such as `` title={`Hello ${name}`} ``.

Dynamic expressions belong in catalogs/runtime i18n, not content
translation. PolyStella does not evaluate JavaScript inside MDX.

## Auditing

Use `polystella audit-mdx` to find likely missed MDX translation
surfaces, such as unconfigured component props or expression props
that should move to a catalog.
