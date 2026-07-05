import { defineMdxRecipe } from "@cloudflare/polystella/recipes";

/**
 * Future recipe fixture for the MDX JSX playground.
 *
 * The package does not support `markdown.mdx.recipes` yet, so this is
 * intentionally not wired into `astro.config.mjs`. It gives the recipe
 * implementation step a concrete design-system-style shape to enable.
 */
export function playgroundDesignSystemRecipe() {
  return defineMdxRecipe({
    htmlAttributes: {
      "*": ["alt", "title", "aria-label", "placeholder"],
    },
    components: {
      Badge: {
        children: true,
      },
      Callout: {
        children: true,
        props: ["title"],
      },
      CodeBlock: {
        children: false,
        props: ["label"],
      },
      FeatureCard: {
        props: ["title", "description"],
      },
      FeatureGrid: {
        props: [],
      },
      Icon: {
        props: ["label"],
      },
    },
    data: {
      "docs/**": {
        features: ["[].title", "[].description"],
        annotatedCards: ["[].title", "[].description"],
      },
    },
  });
}
