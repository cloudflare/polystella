import { describe, expect, it } from "vitest";

import { createMarkdownAdapter, splitMarkdownText } from "../../src/adapters/index.js";

describe("splitMarkdownText", () => {
  const source =
    "# Title\n\nAt [DreamHost](https://dreamhost.com), **open** hosting.\n\n1. Add your site\n2. [Review](/learning/)\n\n| A | B |\n| - | - |\n| one | two |\n\n```js\nconst code = 1;\n```\n";

  it("cuts the same body segments as the Markdown adapter and splices translations in place", () => {
    const split = splitMarkdownText(source);
    const adapter = createMarkdownAdapter();
    const adapterSegments = adapter.extractSegments(adapter.parse(source, "a.md"), source, { sourcePath: "a.md", translatableKeys: {} });
    expect(split.segments).toEqual(adapterSegments);
    expect(split.segments.map(({ text }) => text)).not.toContain("const code = 1;");

    const translated = split.apply(new Map(split.segments.map(({ id, text }) => [id, text.toUpperCase()])));
    expect(translated).toBe(
      "# TITLE\n\nAT [DREAMHOST](HTTPS://DREAMHOST.COM), **OPEN** HOSTING.\n\n1. ADD YOUR SITE\n2. [REVIEW](/LEARNING/)\n\n| A | B |\n| - | - |\n| ONE | TWO |\n\n```js\nconst code = 1;\n```\n",
    );
    expect(() => split.apply(new Map())).toThrow(/missing translation for Markdown segment "body:\d+"/);
  });
});
