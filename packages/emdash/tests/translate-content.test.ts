import type { Translator } from "@cloudflare/polystella-core";
import { EMPTY_GLOSSARY } from "@cloudflare/polystella-core";
import { describe, expect, it } from "vitest";

import { translateContentFields } from "../src/server/translate-content.js";

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

  describe("repeater fields", () => {
    const row = () => ({
      question: " Hi ",
      answer: "Keep",
      image: { id: "m1", alt: "Alt", caption: "Cap", src: "/x.png" },
      url: "/a",
    });
    const translate = (value: unknown, translatorFake: Translator = translator("")) =>
      translateContentFields({
        values: { faq: value },
        repeaterSubFields: { faq: ["question", "image"] },
        translator: translatorFake,
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      });

    it("translates only the chosen subfields, including image alt and caption", async () => {
      const prompts: string[] = [];
      const source = [row()];
      const result = await translate(source, {
        modelId: "test",
        translate: async (_system, user) => {
          prompts.push(user);
          return "@@field:0:item:0:question@@\nSalut\n\n@@field:0:item:0:image:alt@@\nTexte alt\n\n@@field:0:item:0:image:caption@@\nLégende";
        },
      });

      expect(result.patch).toEqual({
        faq: [{ ...row(), question: " Salut ", image: { id: "m1", alt: "Texte alt", caption: "Légende", src: "/x.png" } }],
      });
      expect(source).toEqual([row()]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Hi");
      expect(prompts[0]).toContain("Alt");
      expect(prompts[0]).toContain("Cap");
      for (const untouched of ["Keep", "/a", "m1", "/x.png"]) expect(prompts[0]).not.toContain(untouched);
    });

    it("rejects a repeater value that is not a list of objects", async () => {
      await expect(translate("not a list")).rejects.toThrow("is not a list");
      await expect(translate([row(), "text"])).rejects.toThrow("invalid item");
    });

    it("skips a repeater saved as null", async () => {
      await expect(translate(null)).resolves.toMatchObject({ patch: { faq: null } });
    });
  });
});
