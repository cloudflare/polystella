import type { Translator } from "@cloudflare/polystella-core";
import { EMPTY_GLOSSARY } from "@cloudflare/polystella-core";
import { describe, expect, it } from "vitest";

import { translateContentFields } from "../src/translate-content.js";

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
          ],
        },
        translator: translator("@@field:0:block:0:span:0@@\n{{\n\n@@field:0:block:0:span:1@@\nnom\n\n@@field:0:block:0:span:2@@\n}}"),
        glossary: EMPTY_GLOSSARY,
        sourceLocale: "en-US",
        targetLocale: "fr-FR",
      }),
    ).rejects.toThrow("changed placeholder tokens");
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
});
