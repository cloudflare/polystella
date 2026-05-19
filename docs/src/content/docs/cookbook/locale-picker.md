---
title: Locale picker
description: A copy-paste locale-switcher component for PolyStella sites.
---

A minimal, unstyled locale-switcher component. Renders a list of
`<a>` elements, one per declared locale, linking to the current
page in each locale. The current locale's link gets
`aria-current="page"`. No JS required — it's a server-rendered
list of anchors.

## Why copy-paste

A locale switcher is so site-specific in styling and behaviour
that anything beyond "list of links to other locales" tends to
fight what consumers actually want. Drop this into your project
and adapt as needed.

## The component

Save as `src/components/LocalePicker.astro`:

```astro
---
/**
 * Minimal locale-picker stub. Unstyled anchor list — CSP-safe (no
 * inline JS), accessible (`aria-current`, `hreflang`), zero CSS.
 *
 * Props (all optional):
 *   - `class`        — extra class on the wrapping `<nav>`.
 *   - `label`        — accessible label for the nav.
 *   - `localeLabels` — locale code → display label map; missing
 *                      locales fall through to the raw code.
 *
 * Reads locales from Astro's `astro:config/client` (the user's
 * `astro.config.mjs i18n` block).
 */
import { i18n } from "astro:config/client";

interface Props {
  class?: string;
  label?: string;
  localeLabels?: Record<string, string>;
}

const {
  class: className,
  label = "Locale picker",
  localeLabels = {},
} = Astro.props;

// Defensive: render nothing if `i18n` is absent.
const i18nConfig = i18n;

// `locales` accepts strings OR `{ path, codes }` objects. Normalise
// to `{ path, code }` — `path` for URLs, `code` for `hreflang`.
type LocaleEntry = { path: string; code: string };
const normalised: LocaleEntry[] = (i18nConfig?.locales ?? []).map((entry) => {
  if (typeof entry === "string") {
    return { path: entry, code: entry };
  }
  return {
    path: entry.path,
    code: entry.codes?.[0] ?? entry.path,
  };
});

const defaultLocale: string = i18nConfig?.defaultLocale ?? "";

const prefixDefault =
  typeof i18nConfig?.routing === "object" &&
  i18nConfig.routing.prefixDefaultLocale === true;

const currentLocale = Astro.currentLocale ?? defaultLocale;
const currentPath = Astro.url.pathname;

function canonicalPath(): string {
  for (const { path } of normalised) {
    if (path === defaultLocale && !prefixDefault) continue;
    if (currentPath === `/${path}` || currentPath === `/${path}/`) {
      return "/";
    }
    if (currentPath.startsWith(`/${path}/`)) {
      return currentPath.slice(`/${path}`.length);
    }
  }
  return currentPath;
}

const canonical = canonicalPath();

function urlForLocale(path: string): string {
  if (path === defaultLocale && !prefixDefault) return canonical;
  if (canonical === "/") return `/${path}/`;
  return `/${path}${canonical}`;
}

function labelFor(code: string): string {
  return localeLabels[code] ?? code;
}
---

<nav aria-label={label} class:list={["locale-picker", className]}>
  <ul>
    {
      normalised.map(({ path, code }) => {
        const isCurrent = code === currentLocale;
        return (
          <li>
            <a
              href={urlForLocale(path)}
              hreflang={code}
              aria-current={isCurrent ? "page" : undefined}
            >
              {labelFor(code)}
            </a>
          </li>
        );
      })
    }
  </ul>
</nav>
```

## Usage

```astro
---
import LocalePicker from "../components/LocalePicker.astro";
---

<LocalePicker
  localeLabels={{
    "en-US": "English",
    "pt-BR": "Português",
    "ja-JP": "日本語",
  }}
/>
```

## What it preserves across locales

Clicking the "pt-BR" link from `/blog/foo` should land on
`/pt-BR/blog/foo`, not `/pt-BR/`. The component reads
`Astro.url.pathname` and strips any existing locale prefix before
re-prefixing — keeping the visitor on the same page in the new
language.

## Styling

The component uses semantic HTML:

```html
<nav class="locale-picker" aria-label="Locale picker">
  <ul>
    <li><a href="/" hreflang="en-US" aria-current="page">English</a></li>
    <li><a href="/pt-BR/" hreflang="pt-BR">Português</a></li>
    <li><a href="/ja-JP/" hreflang="ja-JP">日本語</a></li>
  </ul>
</nav>
```

Target the class in your CSS:

```css
.locale-picker ul {
  display: flex;
  list-style: none;
  gap: 1rem;
}
.locale-picker [aria-current="page"] {
  font-weight: bold;
}
```

## What it doesn't do

- **Persist the user's choice.** Each click is a normal navigation.
  If you want to remember a user's locale preference, wire a cookie
  or `localStorage` in your own middleware.
- **Translate locale names automatically.** Pass `localeLabels` or
  hardcode display strings in your wrapper.
