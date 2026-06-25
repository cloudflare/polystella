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
  },
  dryRun: true,
  verbose: true,
};
