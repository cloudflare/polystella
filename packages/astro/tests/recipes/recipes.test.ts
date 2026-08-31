import { describe, expect, it } from "vitest";

import { resolveOptions } from "../../src/config/options.js";
import { normalizeMdxRulesForSource } from "../../src/parsing/mdx-rules.js";
import { defineMdxRecipe, defineScopedMdxRecipe, starlightRecipe } from "../../src/recipes/index.js";

const I18N = {
  defaultLocale: "en-US",
  locales: ["en-US", "pt-BR"],
};

describe("MDX recipes", () => {
  it("defineMdxRecipe returns a plain config fragment accepted by resolveOptions", () => {
    const recipe = defineMdxRecipe({
      components: {
        Hero: { props: ["headline"] },
      },
    });

    const resolved = resolveOptions({ markdown: { mdx: { recipes: [recipe] } } }, I18N);
    const rules = normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/index.mdx");

    expect(rules.components.Hero).toEqual({ props: ["headline"] });
  });

  it("defineScopedMdxRecipe returns a scoped fragment accepted by resolveOptions", () => {
    const recipe = defineScopedMdxRecipe({
      include: ["docs/**"],
      use: {
        components: {
          Callout: { children: true },
        },
      },
    });

    const resolved = resolveOptions({ markdown: { mdx: { recipes: [recipe] } } }, I18N);

    expect(normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/page.mdx").components.Callout).toEqual({ children: true, props: [] });
    expect(normalizeMdxRulesForSource(resolved.markdown.mdx, "blog/page.mdx").components.Callout).toBeUndefined();
  });

  it("starlightRecipe provides conservative component and data rules", () => {
    const resolved = resolveOptions({ markdown: { mdx: { recipes: [starlightRecipe()] } } }, I18N);
    const rules = normalizeMdxRulesForSource(resolved.markdown.mdx, "docs/page.mdx");

    expect(rules.components.Aside).toEqual({ children: true, props: ["title"] });
    expect(rules.components.CodeBlock).toBeUndefined();
    expect(rules.data["**/*.mdx"]?.features).toEqual(["[].title", "[].description"]);
  });
});
