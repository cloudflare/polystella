// @ts-check

export default {
  sourceDir: "./src/content",
  include: ["**/*.{md,mdx}"],
  markdown: {
    keys: {
      "docs/**": ["title", "description"],
    },
    urls: {
      "docs/**": ["canonicalUrl"],
    },
    contextKeys: {
      "docs/**": ["title", "description"],
    },
    mdx: {
      recipes: [
        {
          components: {
            Badge: { children: true },
            Callout: { children: true, props: ["title"] },
            FeatureCard: { props: ["title", "description"] },
            FeatureGrid: { props: [] },
            Icon: { props: ["label"] },
          },
          data: {
            "docs/**": {
              blockFeatures: ["[].title", "[].description"],
              features: ["[].title", "[].description"],
            },
          },
        },
      ],
    },
  },
  dryRun: true,
  verbose: true,
};
