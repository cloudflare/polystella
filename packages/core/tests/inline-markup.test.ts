import { describe, expect, it } from "vitest";

import { EMPTY_GLOSSARY, translateSegments, type Translator } from "../src/index.js";
import { maskInlineMarkup, restoreInlineMarkup } from "../src/inline-markup.js";

describe("inline markup placeholders", () => {
  it.each([
    ["html", "Connect, protect, and build <gradient>everywhere</gradient>", "Connect, protect, and build {{ps_1}}everywhere{{ps_2}}"],
    [
      "html",
      "Nested <b>bold <i>both</i></b>, a <br/> and a < b > c",
      "Nested {{ps_1}}bold {{ps_2}}both{{ps_3}}{{ps_4}}, a {{ps_5}} and a < b > c",
    ],
    [
      "markdown",
      "At [DreamHost](https://www.dreamhost.com), we believe in **open** hosting.",
      "At {{ps_1}}DreamHost{{ps_2}}, we believe in {{ps_3}}open{{ps_4}} hosting.",
    ],
    [
      "markdown",
      "Run `npm i`, keep snake_case_name and 5 * 3, see ![Logo](/a.png) and **_both_**",
      "Run {{ps_1}}, keep snake_case_name and 5 * 3, see {{ps_2}}Logo{{ps_3}} and {{ps_4}}{{ps_5}}both{{ps_6}}{{ps_7}}",
    ],
  ] as const)("masks %s markup in reading order and restores it: %s", (markup, source, expected) => {
    const masked = maskInlineMarkup(source, markup);
    expect(masked?.text).toBe(expected);
    if (masked === null) throw new Error("expected markup");
    expect(restoreInlineMarkup(masked.text, masked)).toEqual({ text: source });
  });

  it("leaves text without markup, or with literal placeholder syntax, unmasked", () => {
    expect(maskInlineMarkup("Plain text, 54%", "markdown")).toBeNull();
    expect(maskInlineMarkup("Literal {{ps_1}} <b>x</b>", "html")).toBeNull();
  });

  it.each([
    ["bygg överallt {{ps_1}}", "missing {{ps_2}}"],
    ["{{ps_2}}överallt{{ps_1}}", "{{ps_2}} must close {{ps_1}}, which has to come before it"],
    ["bygg {{ps_1}}{{ps_2}} överallt", "the text between {{ps_1}} and {{ps_2}} is empty"],
    ["{{ps_1}}a{{ps_1}}b{{ps_2}}", "{{ps_1}} appears 2 times"],
    ["{{ps_1}}a{{ps_3}}{{ps_2}}", "{{ps_3}} is not in the source"],
  ])("rejects %s", (translation, problem) => {
    const masked = maskInlineMarkup("build <gradient>everywhere</gradient>", "html");
    if (masked === null) throw new Error("expected markup");
    expect(restoreInlineMarkup(translation, masked).problems).toContain(problem);
  });

  it("allows pairs to move but not to cross", () => {
    const masked = maskInlineMarkup("<b>bold</b> and <i>italic</i>", "html");
    if (masked === null) throw new Error("expected markup");
    expect(restoreInlineMarkup("{{ps_3}}kursiv{{ps_4}} und {{ps_1}}fett{{ps_2}}", masked)).toEqual({
      text: "<i>kursiv</i> und <b>fett</b>",
    });
    expect(restoreInlineMarkup("{{ps_1}}fett {{ps_3}}und{{ps_2}} kursiv{{ps_4}}", masked).problems?.[0]).toMatch(/must close/);
  });
});

describe("translateSegments with inline markup", () => {
  const base = { glossary: EMPTY_GLOSSARY, sourceLocale: "en", targetLocale: "sv" };

  it("resends only segments whose placeholders came back wrong, once, then fails", async () => {
    const calls: Array<{ user: string; system: string }> = [];
    const answers = ["@@a@@\nbygg överallt {{ps_1}}\n\n@@b@@\nHej", "@@a@@\nbygg {{ps_1}}överallt{{ps_2}}"];
    const translator: Translator = {
      modelId: "stub",
      async translate(system, user) {
        calls.push({ system, user });
        return answers[calls.length - 1] ?? "";
      },
    };
    const segments = [
      { id: "a", text: "build <gradient>everywhere</gradient>", markup: "html" as const },
      { id: "b", text: "Hello" },
    ];
    const result = await translateSegments({ ...base, translator, segments });
    expect(Object.fromEntries(result.translations)).toEqual({ a: "bygg <gradient>överallt</gradient>", b: "Hej" });
    expect(result.batchCount).toBe(2);
    expect(calls[0]?.user).toContain("build {{ps_1}}everywhere{{ps_2}}");
    expect(calls[0]?.system).toContain("Copy every placeholder exactly once");
    expect(calls[1]?.user).not.toContain("@@b@@");
    expect(calls[1]?.system).toContain("Problem: missing {{ps_2}}");

    const stubborn: Translator = { modelId: "stub", translate: async () => "@@a@@\nbygg överallt" };
    await expect(translateSegments({ ...base, translator: stubborn, segments: [segments[0]!] })).rejects.toThrow(
      '[polystella] model changed inline markup in 1 segment(s), first "a": missing {{ps_1}}; missing {{ps_2}}',
    );
  });
});
