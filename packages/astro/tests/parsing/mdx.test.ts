import { describe, expect, it } from "vitest";

import { resolveOptions } from "../../src/config/options.js";
import { markdownAdapter } from "../../src/parsing/adapters/markdown.js";
import { normalizeMdxRulesForSource } from "../../src/parsing/mdx-rules.js";
import { parseMarkdown, parseMdx } from "../../src/parsing/parse.js";

/**
 * MDX support tests.
 *
 * The markdown adapter dispatches by file extension: `.mdx` files
 * route through `parseMdx` (recognising imports/exports, JSX
 * components, and expression bindings as first-class AST nodes);
 * `.md` files (or no path hint) use the plain-markdown parser.
 *
 * Round-trip behaviour for `.mdx`:
 *   - Frontmatter: extracted and translatable as today.
 *   - Prose paragraphs / headings: extracted normally, including
 *     content nested inside JSX components.
 *   - `import` / `export` blocks: preserved byte-perfect, never
 *     extracted (they're code, not prose).
 *   - JSX components (`<Section>`, etc.): preserved byte-perfect.
 *   - Expression bindings (`{value}`): preserved byte-perfect.
 *
 * Pure-markdown features that DON'T survive in MDX (deliberate, by
 * remark-mdx's design): indented code blocks, autolinks
 * (`<https://...>`), and raw block-level HTML rewritten as JSX.
 * `.md` files keep these because they don't go through `parseMdx`.
 */

const SAMPLE_MDX = [
  "---",
  "title: Philosophy",
  "metaTitle: Philosophy",
  "---",
  "",
  'import Section from "@/components/Section.astro";',
  'import NarrowContent from "@/components/NarrowContent.astro";',
  "",
  "<Section>",
  "  <NarrowContent>",
  "",
  "First paragraph of prose.",
  "",
  "## A Hybrid Approach",
  "",
  "Second paragraph.",
  "",
  "  </NarrowContent>",
  "</Section>",
  "",
].join("\n");

const adapterOpts = {
  sourcePath: "pages/philosophy.mdx",
  translatableKeys: { "pages/**": ["title", "metaTitle"] as string[] },
};

const I18N = { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] };

describe("parseMarkdown vs parseMdx", () => {
  it("parseMarkdown does NOT recognise `import` as ESM (treats as paragraph text)", () => {
    const ast = parseMarkdown('import Foo from "./foo";\n');
    expect(ast.children[0]?.type).toBe("paragraph");
  });

  it("parseMdx recognises `import` as `mdxjsEsm`", () => {
    const ast = parseMdx('import Foo from "./foo";\n');
    expect(ast.children[0]?.type).toBe("mdxjsEsm");
  });

  it("parseMdx recognises a block-level JSX component as `mdxJsxFlowElement`", () => {
    const ast = parseMdx("<Foo>\n\nbody\n\n</Foo>\n");
    expect(ast.children[0]?.type).toBe("mdxJsxFlowElement");
  });

  it("parseMarkdown treats the same JSX component as raw HTML", () => {
    // CommonMark + GFM see `<Foo>...</Foo>` as raw block-level HTML.
    const ast = parseMarkdown("<Foo>\n\nbody\n\n</Foo>\n");
    expect(ast.children[0]?.type).toBe("html");
  });
});

describe("markdownAdapter — `.mdx` extension dispatch", () => {
  it("sourcePath ending in `.mdx` selects the MDX parser", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    // First non-yaml child should be `mdxjsEsm` (the import block) —
    // proof that the MDX parser ran.
    const firstNonYaml = parsed.children.find((c) => c.type !== "yaml");
    expect(firstNonYaml?.type).toBe("mdxjsEsm");
  });

  it("sourcePath ending in `.md` selects the plain-markdown parser", () => {
    // Same source, parsed as `.md`: imports become a paragraph.
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.md");
    const firstNonYaml = parsed.children.find((c) => c.type !== "yaml");
    expect(firstNonYaml?.type).toBe("paragraph");
  });

  it("omitted sourcePath defaults to plain-markdown parsing (backward compat)", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX);
    const firstNonYaml = parsed.children.find((c) => c.type !== "yaml");
    expect(firstNonYaml?.type).toBe("paragraph");
  });

  it("case-insensitive extension match (`.MDX` works)", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "Pages/Philosophy.MDX");
    const firstNonYaml = parsed.children.find((c) => c.type !== "yaml");
    expect(firstNonYaml?.type).toBe("mdxjsEsm");
  });
});

describe("markdownAdapter — MDX extraction", () => {
  it("does NOT extract import statements as translatable text", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const segments = markdownAdapter.extractSegments(parsed, SAMPLE_MDX, adapterOpts);
    const texts = segments.map((s) => s.text);
    // Sanity check: prose IS extracted.
    expect(texts).toContain("First paragraph of prose.");
    // No segment should resemble an import statement.
    for (const t of texts) {
      expect(t).not.toMatch(/^import /);
      expect(t).not.toMatch(/from ".*";/);
    }
  });

  it("recurses into block-level JSX components to extract their prose", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const segments = markdownAdapter.extractSegments(parsed, SAMPLE_MDX, adapterOpts);
    const texts = segments.map((s) => s.text);
    expect(texts).toContain("First paragraph of prose.");
    expect(texts).toContain("A Hybrid Approach");
    expect(texts).toContain("Second paragraph.");
  });

  it("recurses through nested JSX components (e.g. `<Section><NarrowContent>...`)", () => {
    // Sanity that two levels of JSX nesting work — both Section and
    // NarrowContent need to be recursed into for the inner prose to
    // surface.
    const nested = ["<Outer>", "<Inner>", "", "Inside two layers.", "", "</Inner>", "</Outer>", ""].join("\n");
    const parsed = markdownAdapter.parse(nested, "pages/test.mdx");
    const segments = markdownAdapter.extractSegments(parsed, nested, adapterOpts);
    expect(segments.map((s) => s.text)).toContain("Inside two layers.");
  });

  it("extracts frontmatter `title` / `metaTitle` as fm:* segments", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const segments = markdownAdapter.extractSegments(parsed, SAMPLE_MDX, adapterOpts);
    const fmSegs = segments.filter((s) => s.id.startsWith("fm:"));
    expect(fmSegs.map((s) => `${s.id}=${s.text}`).sort()).toEqual(["fm:metaTitle=Philosophy", "fm:title=Philosophy"]);
  });

  it("ignores expression bindings (`{value}`) at block level", () => {
    const withExpr = ["{someValue}", "", "Real prose here.", ""].join("\n");
    const parsed = markdownAdapter.parse(withExpr, "pages/test.mdx");
    const segments = markdownAdapter.extractSegments(parsed, withExpr, adapterOpts);
    const texts = segments.map((s) => s.text);
    expect(texts).toContain("Real prose here.");
    expect(texts).not.toContain("{someValue}");
    expect(texts).not.toContain("someValue");
  });
});

describe("markdownAdapter — MDX round-trip", () => {
  it("byte-perfectly preserves imports, components, and indentation; replaces only prose spans", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const segments = markdownAdapter.extractSegments(parsed, SAMPLE_MDX, adapterOpts);
    const translations = new Map(segments.map((s) => [s.id, `TR:${s.text}`]));
    const out = markdownAdapter.applyTranslations(parsed, SAMPLE_MDX, translations, {});

    // Imports preserved exactly.
    expect(out).toContain('import Section from "@/components/Section.astro";');
    expect(out).toContain('import NarrowContent from "@/components/NarrowContent.astro";');
    // Components preserved exactly.
    expect(out).toContain("<Section>");
    expect(out).toContain("</Section>");
    expect(out).toContain("  <NarrowContent>");
    expect(out).toContain("  </NarrowContent>");
    // Prose translated.
    expect(out).toContain("TR:First paragraph of prose.");
    expect(out).toContain("## TR:A Hybrid Approach");
    expect(out).toContain("TR:Second paragraph.");
    // Frontmatter translated.
    expect(out).toContain("title: TR:Philosophy");
    expect(out).toContain("metaTitle: TR:Philosophy");
  });

  it("empty translations map → bytes unchanged (round-trip identity)", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const out = markdownAdapter.applyTranslations(parsed, SAMPLE_MDX, new Map(), {});
    expect(out).toBe(SAMPLE_MDX);
  });

  it("merges top-level additions into MDX frontmatter without breaking imports", () => {
    const parsed = markdownAdapter.parse(SAMPLE_MDX, "pages/philosophy.mdx");
    const out = markdownAdapter.applyTranslations(parsed, SAMPLE_MDX, new Map(), {
      topLevelAdditions: { aiTranslated: true, aiTranslationModel: "test/m1" },
    });
    expect(out).toContain("aiTranslated: true");
    expect(out).toContain("aiTranslationModel: test/m1");
    // Imports still present and unmodified.
    expect(out).toContain('import Section from "@/components/Section.astro";');
  });
});

describe("markdownAdapter — MDX static data config", () => {
  const sourcePath = "docs/static-data.mdx";
  const source = [
    "export const features = [",
    "  {",
    '    title: "Fast setup",',
    "    description: 'Start translating content in minutes.',",
    '    icon: "rocket",',
    "  },",
    "  {",
    '    title: "Cached by default",',
    "    description: 'Translations are reused across builds.',",
    '    icon: "database",',
    "  },",
    "];",
    "",
    "# Static Data",
    "",
    "Body prose.",
    "",
  ].join("\n");

  function mdxRules() {
    const resolved = resolveOptions(
      {
        markdown: {
          mdx: {
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
    return normalizeMdxRulesForSource(resolved.markdown.mdx, sourcePath);
  }

  it("extracts configured string fields from static MDX arrays", () => {
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: mdxRules(),
    });

    expect(segments.map((s) => `${s.id}=${s.text}`)).toEqual([
      "body:0=Static Data",
      "body:1=Body prose.",
      "mdx:data:features[0].title=Fast setup",
      "mdx:data:features[0].description=Start translating content in minutes.",
      "mdx:data:features[1].title=Cached by default",
      "mdx:data:features[1].description=Translations are reused across builds.",
    ]);
    expect(segments.map((s) => s.text)).not.toContain("rocket");
    expect(() => markdownAdapter.groupSegments?.(parsed, segments)).not.toThrow();
  });

  it("applies static data translations by byte-splicing inside quotes", () => {
    const parsed = markdownAdapter.parse(source, sourcePath);
    const rules = mdxRules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: rules,
    });
    const translations = new Map(segments.map((segment) => [segment.id, `TR:${segment.text}`]));

    const out = markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules: rules });

    expect(out).toContain('title: "TR:Fast setup"');
    expect(out).toContain("description: 'TR:Start translating content in minutes.'");
    expect(out).toContain('icon: "rocket"');
    expect(out).toContain("# TR:Static Data");
  });

  it("escapes translated quote characters for the original JS string quote", () => {
    const one = "export const features = [{ title: \"Fast setup\", description: 'Start here.' }];\n";
    const parsed = markdownAdapter.parse(one, sourcePath);
    const rules = mdxRules();
    const translations = new Map([
      ["mdx:data:features[0].title", 'Use "fast" setup'],
      ["mdx:data:features[0].description", "Don't wait"],
    ]);

    const out = markdownAdapter.applyTranslations(parsed, one, translations, { sourcePath, mdxRules: rules });

    expect(out).toContain('title: "Use \\"fast\\" setup"');
    expect(out).toContain("description: 'Don\\'t wait'");
  });
});

describe("markdownAdapter — MDX static data annotations", () => {
  const sourcePath = "docs/annotated.mdx";

  function defaultMdxRules() {
    const resolved = resolveOptions({}, I18N);
    return normalizeMdxRulesForSource(resolved.markdown.mdx, sourcePath);
  }

  it("extracts string fields from annotated static literals without config", () => {
    const source = [
      'export const cards = /** @polystella translate title, description */ [{ title: "Local", description: "Local body", variant: "highlight" }];',
      "",
      "export function getItems() {",
      "  /** @polystella translate title, description */",
      "  return [{ title: 'Returned', description: 'Return body', icon: 'box' }];",
      "}",
      "",
      "<FeatureGrid items={/* @polystella translate title, description */[{ title: 'Inline', description: 'Inline body', icon: 'bolt' }]} />",
      "",
    ].join("\n");
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: defaultMdxRules(),
    });
    const annotationSegments = segments.filter((segment) => segment.id.startsWith("mdx:annotation:"));

    expect(annotationSegments.map((segment) => segment.text)).toEqual([
      "Local",
      "Local body",
      "Returned",
      "Return body",
      "Inline",
      "Inline body",
    ]);
    expect(segments.map((segment) => segment.text)).not.toContain("highlight");
    expect(segments.map((segment) => segment.text)).not.toContain("box");
    expect(segments.map((segment) => segment.text)).not.toContain("bolt");
  });

  it("applies annotated static literal translations", () => {
    const source =
      'export const cards = /** @polystella translate title, description */ [{ title: "Local", description: "Local body" }];\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const rules = defaultMdxRules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: rules,
    });
    const translations = new Map(segments.map((segment) => [segment.id, `TR:${segment.text}`]));

    const out = markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules: rules });

    expect(out).toContain('title: "TR:Local"');
    expect(out).toContain('description: "TR:Local body"');
  });

  it("applies multiline annotated JSX prop literal translations at source byte offsets", () => {
    const source = [
      "<FeatureGrid",
      "  items={",
      "    /* @polystella translate title, description */",
      "    [",
      "      {",
      '        title: "Inline prop data",',
      '        description: "Static arrays passed directly to components.",',
      "      },",
      "    ]",
      "  }",
      "/>",
      "",
    ].join("\n");
    const parsed = markdownAdapter.parse(source, sourcePath);
    const rules = defaultMdxRules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: rules,
    });
    const translations = new Map(segments.map((segment) => [segment.id, `TR:${segment.text}`]));

    const out = markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules: rules });

    expect(out).toContain('title: "TR:Inline prop data"');
    expect(out).toContain('description: "TR:Static arrays passed directly to components."');
  });
});

describe("markdownAdapter — MDX JSX attributes", () => {
  const sourcePath = "docs/attributes.mdx";

  function rules() {
    const resolved = resolveOptions(
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
    return normalizeMdxRulesForSource(resolved.markdown.mdx, sourcePath);
  }

  it("extracts safe HTML attributes and configured component props", () => {
    const source = [
      '<img alt="Cache flow diagram" title="Cache diagram" src="/cache.png" />',
      '<Callout title="Beta notice" type="warning" />',
      '<Callout title={"Expression title"} />',
      "",
    ].join("\n");
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: rules(),
    });

    expect(segments.map((segment) => `${segment.id}=${segment.text}`)).toEqual([
      expect.stringMatching(/^mdx:attr:img\.alt:\d+=Cache flow diagram$/),
      expect.stringMatching(/^mdx:attr:img\.title:\d+=Cache diagram$/),
      expect.stringMatching(/^mdx:attr:Callout\.title:\d+=Beta notice$/),
    ]);
    expect(segments.map((segment) => segment.text)).not.toContain("/cache.png");
    expect(segments.map((segment) => segment.text)).not.toContain("warning");
    expect(segments.map((segment) => segment.text)).not.toContain("Expression title");
  });

  it("applies JSX attribute translations inside the original quotes", () => {
    const source = '<img alt="Cache flow diagram" /><Callout title=\'Beta notice\' type="warning" />\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const mdxRules = rules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules,
    });
    const translations = new Map(segments.map((segment) => [segment.id, `${segment.text} & "translated"`]));

    const out = markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules });

    expect(out).toContain('alt="Cache flow diagram &amp; &quot;translated&quot;"');
    expect(out).toContain("title='Beta notice &amp; \"translated\"'");
    expect(out).toContain('type="warning"');
  });

  it("throws before splicing if replacement spans overlap", () => {
    const source = 'aaaa title="Copy" zzzz';
    const parsed = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: source,
              position: { start: { offset: 0 }, end: { offset: source.length } },
            },
          ],
        },
        {
          type: "mdxJsxFlowElement",
          name: "Callout",
          attributes: [
            {
              type: "mdxJsxAttribute",
              name: "title",
              value: "Copy",
              position: { start: { offset: 5 }, end: { offset: 17 } },
            },
          ],
          children: [],
        },
      ],
    } as unknown as Parameters<typeof markdownAdapter.applyTranslations>[0];
    const translations = new Map([
      ["body:0", "TR:body"],
      ["mdx:attr:Callout.title:12", "TR:prop"],
    ]);

    expect(() => markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules: rules() })).toThrowError(
      /overlapping markdown replacement spans/,
    );
  });
});

describe("markdownAdapter — placeholder-protected inline JSX", () => {
  const sourcePath = "docs/inline.mdx";

  function rules() {
    const resolved = resolveOptions(
      {
        markdown: {
          mdx: {
            components: {
              Icon: { children: false, props: ["label"] },
            },
          },
        },
      },
      I18N,
    );
    return normalizeMdxRulesForSource(resolved.markdown.mdx, sourcePath);
  }

  it("protects inline JSX wrappers while preserving sentence context", () => {
    const source = "This feature is <Badge>new</Badge> and experimental.\n";
    const parsed = markdownAdapter.parse(source, sourcePath);
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules: rules(),
    });

    expect(segments).toEqual([{ id: "body:0", text: 'This feature is <ph id="0">new</ph> and experimental.' }]);
  });

  it("restores moved inline JSX wrapper placeholders during apply", () => {
    const source = "This feature is <Badge>new</Badge> and experimental.\n";
    const parsed = markdownAdapter.parse(source, sourcePath);
    const mdxRules = rules();
    const out = markdownAdapter.applyTranslations(parsed, source, new Map([["body:0", 'Experimental: <ph id="0">nouvelle</ph>.']]), {
      sourcePath,
      mdxRules,
    });

    expect(out).toBe("Experimental: <Badge>nouvelle</Badge>.\n");
  });

  it("protects self-closing inline JSX as opaque placeholders", () => {
    const source = 'Click <Icon name="download" /> to continue.\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const mdxRules = rules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules,
    });

    expect(segments).toEqual([{ id: "body:0", text: 'Click <ph id="0"/> to continue.' }]);

    const out = markdownAdapter.applyTranslations(parsed, source, new Map([["body:0", 'Continue with <ph id="0"/>.']]), {
      sourcePath,
      mdxRules,
    });
    expect(out).toBe('Continue with <Icon name="download" />.\n');
  });

  it("translates configured props inside opaque inline JSX placeholders", () => {
    const source = 'Click <Icon name="download" label="Download" /> to continue.\n';
    const parsed = markdownAdapter.parse(source, sourcePath);
    const mdxRules = rules();
    const segments = markdownAdapter.extractSegments(parsed, source, {
      sourcePath,
      translatableKeys: {},
      mdxRules,
    });

    expect(segments.map((segment) => `${segment.id}=${segment.text}`)).toEqual([
      'body:0=Click <ph id="0"/> to continue.',
      expect.stringMatching(/^mdx:inline-attr:Icon\.label:\d+=Download$/),
    ]);

    const labelSegment = segments.find((segment) => segment.id.startsWith("mdx:inline-attr:Icon.label:"));
    expect(labelSegment).toBeDefined();
    const translations = new Map([
      ["body:0", 'Continue with <ph id="0"/>.'],
      [labelSegment?.id ?? "", "Baixar"],
    ]);

    const out = markdownAdapter.applyTranslations(parsed, source, translations, { sourcePath, mdxRules });

    expect(out).toBe('Continue with <Icon name="download" label="Baixar" />.\n');
  });

  it("throws when translated output corrupts inline JSX placeholders", () => {
    const source = "This feature is <Badge>new</Badge> and experimental.\n";
    const parsed = markdownAdapter.parse(source, sourcePath);
    const mdxRules = rules();

    expect(() =>
      markdownAdapter.applyTranslations(parsed, source, new Map([["body:0", "La fonctionnalite est nouvelle."]]), {
        sourcePath,
        mdxRules,
      }),
    ).toThrowError(/placeholder/);
  });
});

describe("plain-markdown features still work for `.md` files", () => {
  // Regression: adding remark-mdx to the pipeline disabled some
  // markdown features (indented code, autolinks, raw HTML at block
  // level). Routing by extension means `.md` files keep the old
  // behaviour.

  it("`.md` parses indented code as a code block (not as paragraph text)", () => {
    const indented = "Plain paragraph.\n\n    code line 1\n    code line 2\n";
    const parsed = markdownAdapter.parse(indented, "test.md");
    // Walk children: should find a `code` node.
    const types = parsed.children.map((c) => c.type);
    expect(types).toContain("code");
  });

  it("`.md` parses autolinks (`<https://example.com>`) without throwing", () => {
    // The MDX parser throws on autolink syntax (sees `<` as JSX-start).
    // The plain markdown parser accepts it.
    const auto = "See <https://example.com> for details.\n";
    expect(() => markdownAdapter.parse(auto, "test.md")).not.toThrow();
  });

  it("`.md` parses block-level raw HTML as `html` nodes (not `mdxJsxFlowElement`)", () => {
    const html = "<aside>\n\nInside aside.\n\n</aside>\n";
    const parsed = markdownAdapter.parse(html, "test.md");
    const types = parsed.children.map((c) => c.type);
    expect(types).toContain("html");
    expect(types).not.toContain("mdxJsxFlowElement");
  });
});
