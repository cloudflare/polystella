import type { Translator } from "@cloudflare/polystella-core";
import { EMPTY_GLOSSARY } from "@cloudflare/polystella-core";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contentSegmentLabel } from "../src/server/routes/debug-collector.js";
import { EMDASH_BLOCK_FIELDS, translateContentFields } from "../src/server/translate-content.js";

function translator(response: string): Translator {
  return { modelId: "test", translate: async () => response };
}

describe("translateContentFields", () => {
  it("translates strings and standard Portable Text spans without changing structure", async () => {
    const body = [
      {
        _type: "block",
        _key: "block-1",
        children: [{ _type: "span", _key: "span-1", text: "World", marks: ["strong"] }],
        markDefs: [{ _key: "link-1", _type: "link", href: "https://example.com" }],
      },
      { _type: "code", _key: "code-1", code: "const greeting = 'Hello'" },
    ];
    const result = await translateContentFields({
      values: { title: "Hello {{name}}", body },
      translator: translator("@@field:0@@\nBonjour {{name}}\n\n@@field:1:block:0:span:0@@\nMonde"),
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "fr-FR",
    });

    expect(result.patch).toEqual({
      title: "Bonjour {{name}}",
      body: [
        {
          _type: "block",
          _key: "block-1",
          children: [{ _type: "span", _key: "span-1", text: "Monde", marks: ["strong"] }],
          markDefs: [{ _key: "link-1", _type: "link", href: "https://example.com" }],
        },
        { _type: "code", _key: "code-1", code: "const greeting = 'Hello'" },
      ],
    });
    expect(body[0]).toMatchObject({ children: [{ text: "World" }] });
  });

  it("translates Portable Text table cells and keeps the table structure", async () => {
    const cell = (key: string, text: string) => ({ _type: "tableCell", _key: key, content: [{ _type: "span", _key: "s0", text }] });
    const table = {
      _type: "table",
      _key: "b1",
      rows: [
        { _type: "tableRow", _key: "r0", cells: [cell("c0", "Rule"), cell("c1", "Rule ID")] },
        { _type: "tableRow", _key: "r1", cells: [cell("c2", "Generic rule"), cell("c3", "   ")] },
      ],
    };
    const result = await translateContentFields({
      values: { body: [table] },
      translator: translator(
        "@@field:0:block:0:row:0:cell:0:span:0@@\nRegra\n\n@@field:0:block:0:row:0:cell:1:span:0@@\nID da regra\n\n@@field:0:block:0:row:1:cell:0:span:0@@\nRegra genérica",
      ),
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(result.patch).toEqual({
      body: [
        {
          ...table,
          rows: [
            { _type: "tableRow", _key: "r0", cells: [cell("c0", "Regra"), cell("c1", "ID da regra")] },
            { _type: "tableRow", _key: "r1", cells: [cell("c2", "Regra genérica"), cell("c3", "   ")] },
          ],
        },
      ],
    });
  });

  it("preserves span boundary whitespace", async () => {
    const result = await translateContentFields({
      values: {
        body: [{ _type: "block", _key: "block-1", children: [{ _type: "span", _key: "span-1", text: " Hello " }] }],
      },
      translator: translator("@@field:0:block:0:span:0@@\nBonjour"),
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "fr-FR",
    });

    expect(result.patch).toMatchObject({ body: [{ children: [{ text: " Bonjour " }] }] });
  });

  it("rejects placeholder changes split across Portable Text spans", async () => {
    const validationIssues: Array<{ segmentIds: string[]; message: string }> = [];
    await expect(
      translateContentFields({
        values: {
          body: [
            {
              _type: "block",
              _key: "block-1",
              children: [
                { _type: "span", _key: "span-1", text: "{{" },
                { _type: "span", _key: "span-2", text: "name" },
                { _type: "span", _key: "span-3", text: "}}" },
              ],
            },
            {
              _type: "block",
              _key: "block-2",
              children: [{ _type: "span", _key: "span-4", text: "Other block" }],
            },
          ],
        },
        translator: translator(
          "@@field:0:block:0:span:0@@\n{{\n\n@@field:0:block:0:span:1@@\nnom\n\n@@field:0:block:0:span:2@@\n}}\n\n@@field:0:block:1:span:0@@\nAutre bloc",
        ),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
        onValidationIssue: (segmentIds, message) => validationIssues.push({ segmentIds, message }),
      }),
    ).rejects.toThrow("changed placeholder tokens");
    expect(validationIssues).toEqual([
      {
        segmentIds: ["field:0:block:0:span:0", "field:0:block:0:span:1", "field:0:block:0:span:2"],
        message: expect.stringContaining("changed placeholder tokens"),
      },
    ]);
  });

  it("rejects placeholder changes and unsupported field values", async () => {
    await expect(
      translateContentFields({
        values: { title: "Hello {{name}}" },
        translator: translator("@@field:0@@\nBonjour"),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      }),
    ).rejects.toThrow("changed placeholder tokens");

    await expect(
      translateContentFields({
        values: { count: 2 },
        translator: translator(""),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      }),
    ).rejects.toThrow("not supported");
  });

  it("rejects malformed or excessive input before calling the provider", async () => {
    await expect(
      translateContentFields({
        values: { body: [{ _type: "block", _key: "block-1", children: [{ _type: "span", _key: "span-1" }] }] },
        translator: translator(""),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      }),
    ).rejects.toThrow("invalid span");

    await expect(
      translateContentFields({
        values: Object.fromEntries(Array.from({ length: 26 }, (_, index) => [`field-${index}`, "Text"])),
        translator: translator(""),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      }),
    ).rejects.toThrow("more than 25 fields");
  });

  describe("custom blocks", () => {
    const heroSource = {
      _type: "marketing.hero",
      _key: "hero-1",
      headline: "Build faster",
      primaryCtaUrl: "/start",
      banners: [{ title: "New", linkHref: "/new" }, { title: "Beta" }],
      tags: ["one", "two"],
      columns: [
        {
          content: [{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Nested" }] }],
        },
      ],
    };

    async function translateHero(response: string, blockFields: Record<string, string[]>) {
      return translateContentFields({
        values: { body: [structuredClone(heroSource)] },
        translator: translator(response),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
        blockFields,
      });
    }

    it("translates only the listed paths and leaves everything else untouched", async () => {
      const result = await translateHero(
        [
          "@@field:0:block:0:headline@@\nConstruisez plus vite",
          "@@field:0:block:0:banners:0:title@@\nNouveau",
          "@@field:0:block:0:banners:1:title@@\nBêta",
          "@@field:0:block:0:tags:0@@\nun",
          "@@field:0:block:0:tags:1@@\ndeux",
          "@@field:0:block:0:columns:0:content:block:0:span:0@@\nImbriqué",
        ].join("\n\n"),
        { "marketing.hero": ["headline", "banners[].title", "tags[]", "columns[].content"] },
      );

      expect(result.patch).toEqual({
        body: [
          {
            ...heroSource,
            headline: "Construisez plus vite",
            banners: [{ title: "Nouveau", linkHref: "/new" }, { title: "Bêta" }],
            tags: ["un", "deux"],
            columns: [{ content: [{ _type: "block", _key: "b1", children: [{ _type: "span", _key: "s1", text: "Imbriqué" }] }] }],
          },
        ],
      });
    });

    it("skips custom blocks with no configured paths", async () => {
      const result = await translateContentFields({
        values: { body: [heroSource, { _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "Hi" }] }] },
        translator: translator("@@field:0:block:1:span:0@@\nSalut"),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      });

      expect(result.patch).toMatchObject({ body: [heroSource, { children: [{ text: "Salut" }] }] });
    });

    it("rejects placeholder changes in block text", async () => {
      await expect(
        translateContentFields({
          values: { body: [{ _type: "marketing.hero", _key: "h", headline: "Hi {{name}}" }] },
          translator: translator("@@field:0:block:0:headline@@\nSalut"),
          glossary: EMPTY_GLOSSARY,
          sourceLocale: "en-US",
          targetLocale: "fr-FR",
          blockFields: { "marketing.hero": ["headline"] },
        }),
      ).rejects.toThrow("changed placeholder tokens");
    });

    it("rejects placeholder changes split across spans in nested Portable Text", async () => {
      const validationIssues: string[][] = [];
      await expect(
        translateContentFields({
          values: {
            body: [
              {
                _type: "marketing.columns",
                _key: "c",
                columns: [
                  {
                    content: [
                      {
                        _type: "block",
                        _key: "b",
                        children: [
                          { _type: "span", _key: "s1", text: "{{" },
                          { _type: "span", _key: "s2", text: "name" },
                          { _type: "span", _key: "s3", text: "}}" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          translator: translator(
            [
              "@@field:0:block:0:columns:0:content:block:0:span:0@@\n{{",
              "@@field:0:block:0:columns:0:content:block:0:span:1@@\nnom",
              "@@field:0:block:0:columns:0:content:block:0:span:2@@\n}}",
            ].join("\n\n"),
          ),
          glossary: EMPTY_GLOSSARY,
          sourceLocale: "en-US",
          targetLocale: "fr-FR",
          blockFields: { "marketing.columns": ["columns[].content"] },
          onValidationIssue: (segmentIds) => validationIssues.push(segmentIds),
        }),
      ).rejects.toThrow("changed placeholder tokens");
      expect(validationIssues).toEqual([
        [
          "field:0:block:0:columns:0:content:block:0:span:0",
          "field:0:block:0:columns:0:content:block:0:span:1",
          "field:0:block:0:columns:0:content:block:0:span:2",
        ],
      ]);
    });

    it("names the exact location of invalid nested content", async () => {
      await expect(
        translateContentFields({
          values: {
            body: [{ _type: "marketing.columns", _key: "c", columns: [{ content: [{ _type: "block", children: [] }] }] }],
          },
          translator: translator(""),
          glossary: EMPTY_GLOSSARY,
          sourceLocale: "en-US",
          targetLocale: "fr-FR",
          blockFields: { "marketing.columns": ["columns[].content"] },
        }),
      ).rejects.toThrow('Portable Text field "body" contains an invalid block at body[0].columns[0].content[0]');
    });
  });

  it("labels standard, table and custom block segments for the debug view", () => {
    const fields = ["title", "body"];
    expect(contentSegmentLabel("field:0", fields)).toBe("title");
    expect(contentSegmentLabel("field:1:block:2:span:0", fields)).toBe("body (block 2, span 0)");
    expect(contentSegmentLabel("field:1:block:2:row:1:cell:0:span:0", fields)).toBe("body (block 2, row 1, cell 0, span 0)");
    expect(contentSegmentLabel("field:1:block:3:cards:1:title", fields)).toBe("body (block 3, cards 1 title)");
  });
});

describe("EmDash block type defaults", () => {
  const echo: Translator = {
    modelId: "echo",
    translate: async (_system, user) => [...user.matchAll(/^@@([^@\n]+?)@@\s*$/gm)].map((match) => `@@${match[1]}@@\nFR`).join("\n\n"),
  };
  const paragraph = (key: string, text: string) => ({
    _type: "block",
    _key: key,
    style: "normal",
    markDefs: [],
    children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
  });
  const body = [
    { _type: "image", _key: "i", asset: { _ref: "m1" }, alt: "A cat", caption: "Our cat" },
    { _type: "buttons", _key: "b", buttons: [{ _type: "button", _key: "b1", text: "Sign up", url: "/signup" }] },
    { _type: "columns", _key: "c", columns: [{ _type: "column", _key: "c1", content: [paragraph("p", "Column text")] }] },
    { _type: "code", _key: "k", code: "const a = 1" },
  ];

  it("translates EmDash's own block types without configuration, and lets a site replace or turn off a default", async () => {
    const base = { translator: echo, glossary: EMPTY_GLOSSARY, sourceLocale: "en", targetLocale: "fr" };
    const { patch } = await translateContentFields({ ...base, values: { body } });
    expect(patch.body).toEqual([
      { ...body[0], alt: "FR", caption: "FR" },
      { ...body[1], buttons: [{ _type: "button", _key: "b1", text: "FR", url: "/signup" }] },
      { ...body[2], columns: [{ _type: "column", _key: "c1", content: [paragraph("p", "FR")] }] },
      body[3],
    ]);

    const overridden = await translateContentFields({ ...base, values: { body }, blockFields: { image: ["alt"], buttons: [] } });
    expect(overridden.patch.body).toMatchObject([{ alt: "FR", caption: "Our cat" }, { buttons: [{ text: "Sign up" }] }, {}, {}]);
  });

  it("translates `blocks` fields with the site's blockFields only", async () => {
    const layout = [
      { _type: "hero", _version: 1, _key: "h", heading: "Welcome", body: [paragraph("p", "Intro")], link_label: "More", link_url: "/more" },
      { _type: "image", _version: 1, _key: "i", photo: { id: "m1" }, alt: "Site-defined image block" },
      { _type: "table", _version: 2, _key: "t", heading: "Not a Portable Text table" },
    ];
    const { patch } = await translateContentFields({
      translator: echo,
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en",
      targetLocale: "fr",
      values: { layout },
      blockFields: { hero: ["heading", "body", "link_label"], table: ["heading"] },
      blocksFieldSlugs: ["layout"],
    });
    expect(patch.layout).toEqual([
      { ...layout[0], heading: "FR", body: [paragraph("p", "FR")], link_label: "FR" },
      layout[1],
      { ...layout[2], heading: "FR" },
    ]);
    await expect(
      translateContentFields({
        translator: echo,
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en",
        targetLocale: "fr",
        values: { layout: [{ heading: "No type" }] },
        blocksFieldSlugs: ["layout"],
      }),
    ).rejects.toThrow('blocks field "layout" contains an invalid block at layout[0]');
  });

  it("is re-checked whenever the tested EmDash version changes", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    // Bumping EmDash? Compare EMDASH_BLOCK_FIELDS with EmDash's src/content/converters and src/components, then update this.
    expect(manifest.devDependencies.emdash, "EMDASH_BLOCK_FIELDS was last checked against EmDash 1.5.0").toBe("1.5.0");
    expect(Object.keys(EMDASH_BLOCK_FIELDS)).not.toContain("code");
  });
});
