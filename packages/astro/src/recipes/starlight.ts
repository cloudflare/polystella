import { defineMdxRecipe } from "./types.js";

/**
 * Conservative MDX rules for common Starlight component conventions.
 * Consumers opt in explicitly; no component-source inference happens.
 */
export function starlightRecipe() {
  return defineMdxRecipe({
    htmlAttributes: {
      "*": ["alt", "title", "aria-label", "placeholder"],
    },
    components: {
      Aside: {
        children: true,
        props: ["title"],
      },
      Badge: {
        children: true,
        props: ["text"],
      },
      Card: {
        children: true,
        props: ["title"],
      },
      CardGrid: {
        children: true,
        props: [],
      },
      LinkCard: {
        props: ["title", "description"],
      },
      Steps: {
        children: true,
        props: [],
      },
      TabItem: {
        children: true,
        props: ["label"],
      },
      Tabs: {
        children: true,
        props: [],
      },
    },
    data: {
      "**/*.mdx": {
        cards: ["[].title", "[].description"],
        faqs: ["[].question", "[].answer"],
        features: ["[].title", "[].description"],
        steps: ["[].title", "[].description"],
      },
    },
  });
}
