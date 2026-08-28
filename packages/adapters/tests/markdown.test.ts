import type { Root } from "mdast";
import { describe, expect, it, vi } from "vitest";

import {
  createMarkdownAdapter,
  markdownAdapter,
  parseMarkdown,
  parseMdx,
  remarkMarkdownParser,
  type MarkdownParser,
} from "../src/index.js";

describe("portable parser", () => {
  it("keeps Markdown and MDX syntax distinct", () => {
    expect(parseMarkdown('import Component from "./component.js";\n').children[0]?.type).toBe("paragraph");
    expect(parseMdx('import Component from "./component.js";\n').children[0]?.type).toBe("mdxjsEsm");
    expect(parseMarkdown("<Aside>\n\nBody\n\n</Aside>\n").children[0]?.type).toBe("html");
    expect(parseMdx("<Aside>\n\nBody\n\n</Aside>\n").children[0]?.type).toBe("mdxJsxFlowElement");
  });

  it("dispatches through an injected parser by extension", () => {
    const markdownRoot = { type: "root", children: [] } as Root;
    const mdxRoot = { type: "root", children: [] } as Root;
    const parser: MarkdownParser = {
      parseMarkdown: vi.fn(() => markdownRoot),
      parseMdx: vi.fn(() => mdxRoot),
    };
    const adapter = createMarkdownAdapter(parser);
    expect(adapter.parse("source", "file.md")).toBe(markdownRoot);
    expect(adapter.parse("source", "file.MDX")).toBe(mdxRoot);
    expect(parser.parseMarkdown).toHaveBeenCalledOnce();
    expect(parser.parseMdx).toHaveBeenCalledOnce();
  });

  it("uses Remark by default", () => {
    expect(markdownAdapter.parse("# Heading", "file.md")).toEqual(remarkMarkdownParser.parseMarkdown("# Heading"));
  });
});

describe("Markdown reconstruction", () => {
  const source = [
    "---",
    "title: Hello",
    "tags:",
    "  - First",
    "  - Second",
    "---",
    "",
    "# Heading",
    "",
    "A **formatted** [paragraph](/docs).",
  ].join("\n");
  const options = {
    sourcePath: "docs/example.md",
    translatableKeys: { "docs/**": ["title", "tags"] },
  };

  it("extracts stable body and frontmatter IDs and applies only their spans", () => {
    const parsed = markdownAdapter.parse(source, options.sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    expect(segments).toEqual([
      { id: "body:0", text: "Heading" },
      { id: "body:1", text: "A **formatted** [paragraph](/docs)." },
      { id: "fm:title", text: "Hello" },
      { id: "fm:tags[0]", text: "First" },
      { id: "fm:tags[1]", text: "Second" },
    ]);
    const output = markdownAdapter.applyTranslations(
      parsed,
      source,
      new Map(segments.map((segment) => [segment.id, `X:${segment.text}`])),
      { topLevelAdditions: { aiTranslated: true } },
    );
    expect(output).toContain("title: X:Hello");
    expect(output).toContain("- X:First");
    expect(output).toContain("aiTranslated: true");
    expect(output).toContain("# X:Heading");
    expect(output).toContain("X:A **formatted** [paragraph](/docs).");
  });

  it("returns source bytes unchanged without translations or additions", () => {
    const parsed = markdownAdapter.parse(source, options.sourcePath);
    expect(markdownAdapter.applyTranslations(parsed, source, new Map())).toBe(source);
  });

  it("applies generic additions idempotently", () => {
    const once = markdownAdapter.applyTranslations(markdownAdapter.parse(source, options.sourcePath), source, new Map(), {
      topLevelAdditions: { aiTranslated: true },
    });
    const twice = markdownAdapter.applyTranslations(markdownAdapter.parse(once, options.sourcePath), once, new Map(), {
      topLevelAdditions: { aiTranslated: true },
    });
    expect(twice).toBe(once);
  });

  it("adds generic frontmatter fields when existing frontmatter is empty", () => {
    const source = "---\n---\n\nBody.\n";
    const output = markdownAdapter.applyTranslations(markdownAdapter.parse(source, options.sourcePath), source, new Map(), {
      topLevelAdditions: { aiTranslated: true },
    });
    expect(output).toBe("---\naiTranslated: true\n---\n\nBody.\n");
  });

  it("groups by heading while preserving reference identity and order", () => {
    const groupedSource = "Lede.\n\n## First\n\nBody one.\n\n## Second\n\nBody two.\n";
    const parsed = markdownAdapter.parse(groupedSource, "docs/grouped.md");
    const segments = markdownAdapter.extractSegments(parsed, groupedSource, {
      sourcePath: "docs/grouped.md",
      translatableKeys: {},
    });
    const groups = markdownAdapter.groupSegments?.(parsed, segments) ?? [];
    expect(groups.map((group) => group.map((segment) => segment.id))).toEqual([["body:0"], ["body:1", "body:2"], ["body:3", "body:4"]]);
    expect(groups.flat().every((segment, index) => segment === segments[index])).toBe(true);
  });

  it.each([
    ["lists", "- First item\n- Second item with **bold** text.\n"],
    ["blockquote", "> Quoted text.\n>\n> Second paragraph.\n"],
    ["table", "| Name | Value |\n| --- | --- |\n| One | Two |\n"],
    ["footnote", "Text with a footnote.[^1]\n\n[^1]: Footnote body.\n"],
    ["code", "Paragraph.\n\n```ts\nconst value = 1;\n```\n"],
    ["html", "<aside>\n\nRaw HTML body.\n\n</aside>\n"],
    ["autolink", "See <https://example.com> for details.\n"],
    ["escapes", "Literal \\[brackets\\], S&P, and `inline code`.\n"],
  ])("round-trips representative %s syntax byte-for-byte", (_name, fixture) => {
    const parsed = markdownAdapter.parse(fixture, "docs/fixture.md");
    markdownAdapter.extractSegments(parsed, fixture, { sourcePath: "docs/fixture.md", translatableKeys: {} });
    expect(markdownAdapter.applyTranslations(parsed, fixture, new Map())).toBe(fixture);
  });
});
