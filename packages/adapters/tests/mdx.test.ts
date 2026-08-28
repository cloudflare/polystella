import { describe, expect, it } from "vitest";

import { markdownAdapter, MDX_RULES_VERSION, MdxPlaceholderError, type NormalizedMdxRules } from "../src/index.js";

const sourcePath = "docs/example.mdx";
const rules: NormalizedMdxRules = {
  version: MDX_RULES_VERSION,
  htmlAttributes: { "*": ["alt", "title", "aria-label", "placeholder"] },
  components: {
    Callout: { props: ["title"] },
    Icon: { children: false, props: ["label"] },
  },
  data: {
    "docs/**": { features: ["[].title", "[].description"] },
  },
};

const options = { sourcePath, translatableKeys: {}, mdxRules: rules };

describe("MDX reconstruction", () => {
  it("preserves ESM and JSX while translating prose and configured static data", () => {
    const source = [
      'import Grid from "../Grid.astro";',
      "",
      "export const features = [",
      '  { title: "Fast setup", description: "Start quickly", icon: "rocket" },',
      "];",
      "",
      "<Grid>",
      "",
      "# Feature list",
      "",
      "Body prose.",
      "",
      "</Grid>",
      "",
    ].join("\n");
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    expect(segments.map(({ id, text }) => `${id}=${text}`)).toEqual([
      "body:0=Feature list",
      "body:1=Body prose.",
      "mdx:data:features[0].title=Fast setup",
      "mdx:data:features[0].description=Start quickly",
    ]);
    const output = markdownAdapter.applyTranslations(
      parsed,
      source,
      new Map(segments.map((segment) => [segment.id, `X:${segment.text}`])),
      { sourcePath, mdxRules: rules },
    );
    expect(output).toContain('import Grid from "../Grid.astro";');
    expect(output).toContain('title: "X:Fast setup"');
    expect(output).toContain('description: "X:Start quickly"');
    expect(output).toContain('icon: "rocket"');
    expect(output).toContain("# X:Feature list");
  });

  it("extracts and safely applies configured flow-element attributes", () => {
    const source = '<img alt="Diagram" src="/diagram.png" />\n<Callout title=\'Notice\' type="warning" />\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    expect(segments.map((segment) => segment.text)).toEqual(["Diagram", "Notice"]);
    const output = markdownAdapter.applyTranslations(
      parsed,
      source,
      new Map(segments.map((segment) => [segment.id, `${segment.text} & "translated"`])),
      { sourcePath, mdxRules: rules },
    );
    expect(output).toContain('alt="Diagram &amp; &quot;translated&quot;"');
    expect(output).toContain("title='Notice &amp; \"translated\"'");
    expect(output).toContain('src="/diagram.png"');
  });

  it("protects inline wrappers and opaque components, including configured props", () => {
    const source = 'This is <Badge>new</Badge>; click <Icon name="download" label="Download" />.\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    expect(segments[0]).toEqual({ id: "body:0", text: 'This is <ph id="0">new</ph>; click <ph id="1"/>.' });
    const label = segments.find((segment) => segment.id.startsWith("mdx:inline-attr:Icon.label:"));
    expect(label?.text).toBe("Download");
    const output = markdownAdapter.applyTranslations(
      parsed,
      source,
      new Map([
        ["body:0", 'Clique <ph id="1"/>; isto e <ph id="0">novo</ph>.'],
        [label?.id ?? "", "Baixar"],
      ]),
      { sourcePath, mdxRules: rules },
    );
    expect(output).toBe('Clique <Icon name="download" label="Baixar" />; isto e <Badge>novo</Badge>.\n');
  });

  it("rejects lost or duplicated inline placeholders", () => {
    const source = "This is <Badge>new</Badge>.\n";
    const parsed = markdownAdapter.parse(source, sourcePath);
    expect(() =>
      markdownAdapter.applyTranslations(parsed, source, new Map([["body:0", "No placeholder"]]), {
        sourcePath,
        mdxRules: rules,
      }),
    ).toThrow(MdxPlaceholderError);
  });

  it("extracts annotation-selected static literals", () => {
    const source =
      'export const cards = /** @polystella translate title, description */ [{ title: "Local", description: "Body", icon: "box" }];\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    expect(segments.map((segment) => segment.text)).toEqual(["Local", "Body"]);
  });

  it("escapes static-data translations for their original quote style", () => {
    const source = "export const features = [{ title: \"Fast\", description: 'Start' }];\n";
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, options);
    const output = markdownAdapter.applyTranslations(
      parsed,
      source,
      new Map([
        [segments[0]?.id ?? "", 'Use "fast"'],
        [segments[1]?.id ?? "", "Don't wait"],
      ]),
      { sourcePath, mdxRules: rules },
    );
    expect(output).toContain('title: "Use \\"fast\\""');
    expect(output).toContain("description: 'Don\\'t wait'");
  });

  it("groups MDX prose, static data, and frontmatter without cloning or reordering", () => {
    const source = [
      "---",
      "title: Example",
      "---",
      "",
      'export const features = [{ title: "Fast", description: "Start" }];',
      "",
      "# Heading",
      "",
      "Body.",
    ].join("\n");
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, {
      ...options,
      translatableKeys: { "docs/**": ["title"] },
    });
    const groups = markdownAdapter.groupSegments?.(parsed, segments) ?? [];
    expect(groups.flat().map((segment) => segment.id)).toEqual(segments.map((segment) => segment.id));
    expect(groups.flat().every((segment, index) => segment === segments[index])).toBe(true);
    expect(groups.at(-1)?.map((segment) => segment.id)).toEqual(["fm:title"]);
  });
});
