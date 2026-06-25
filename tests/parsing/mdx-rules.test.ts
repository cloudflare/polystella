import { describe, expect, it } from "vitest";

import { resolveOptions } from "../../src/config/options.js";
import {
  computeMdxRulesPolicyHash,
  DEFAULT_MDX_HTML_ATTRIBUTES,
  MDX_RULES_VERSION,
  normalizeMdxRulesForSource,
} from "../../src/parsing/mdx-rules.js";

const I18N = {
  defaultLocale: "en-US",
  locales: ["en-US", "pt-BR"],
};

describe("normalizeMdxRulesForSource", () => {
  it("starts with safe HTML attribute defaults", () => {
    const resolved = resolveOptions({}, I18N);

    const rules = normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/page.mdx");

    expect(rules.version).toBe(MDX_RULES_VERSION);
    expect(rules.htmlAttributes).toEqual(DEFAULT_MDX_HTML_ATTRIBUTES);
    expect(rules.components).toEqual({});
    expect(rules.data).toEqual({});
  });

  it("merges recipes in order, then project config", () => {
    const resolved = resolveOptions(
      {
        markdown: {
          mdx: {
            recipes: [
              {
                components: {
                  Callout: { children: true, props: ["title"] },
                },
              },
              {
                components: {
                  Callout: { props: ["heading"] },
                  Badge: { children: true },
                },
              },
            ],
            components: {
              Callout: { children: false },
            },
          },
        },
      },
      I18N,
    );

    const rules = normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/page.mdx");

    expect(rules.components.Callout).toEqual({ children: false, props: ["heading"] });
    expect(rules.components.Badge).toEqual({ children: true, props: [] });
  });

  it("applies scoped recipes only when include/exclude patterns match", () => {
    const resolved = resolveOptions(
      {
        markdown: {
          mdx: {
            recipes: [
              {
                include: ["docs/**"],
                exclude: ["docs/private/**"],
                use: {
                  data: {
                    "docs/**": {
                      features: ["[].title"],
                    },
                  },
                },
              },
            ],
          },
        },
      },
      I18N,
    );

    expect(normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/public/page.mdx").data["docs/**"]?.features).toEqual(["[].title"]);
    expect(normalizeMdxRulesForSource(resolved.markdown.mdx, "blog/page.mdx").data).toEqual({});
    expect(normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/private/page.mdx").data).toEqual({});
  });

  it("project config overrides same-key recipe data and attributes", () => {
    const resolved = resolveOptions(
      {
        markdown: {
          mdx: {
            recipes: [
              {
                htmlAttributes: { "*": ["alt", "title"] },
                data: {
                  "docs/**": {
                    features: ["[].title"],
                  },
                },
              },
            ],
            htmlAttributes: { "*": ["alt"] },
            data: {
              "docs/**": {
                features: ["[].title", "[].description"],
              },
            },
          },
        },
      },
      I18N,
    );

    const rules = normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/page.mdx");

    expect(rules.htmlAttributes["*"]).toEqual(["alt"]);
    expect(rules.data["docs/**"]?.features).toEqual(["[].title", "[].description"]);
  });

  it("policy hash changes when normalized MDX rules change", () => {
    const base = resolveOptions({}, I18N);
    const withComponent = resolveOptions(
      {
        markdown: {
          mdx: {
            components: {
              Callout: { props: ["title"] },
            },
          },
        },
      },
      I18N,
    );

    const baseHash = computeMdxRulesPolicyHash(normalizeMdxRulesForSource(base.markdown.mdx, "docs/page.mdx"));
    const changedHash = computeMdxRulesPolicyHash(normalizeMdxRulesForSource(withComponent.markdown.mdx, "docs/page.mdx"));

    expect(baseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(changedHash).not.toBe(baseHash);
  });
});
