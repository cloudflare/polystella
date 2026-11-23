import { describe, expect, it } from "vitest";

import {
  EMPTY_GLOSSARY,
  PromptTooLargeError,
  selectGlossaryForText,
  translateSegments,
  type Glossary,
  type Translator,
} from "../src/index.js";

const glossary: Glossary = {
  ...EMPTY_GLOSSARY,
  doNotTranslate: ["API", "Cloudflare Access", ".NET"],
  preferredTranslations: { Access: "Accès", Worker: "Worker (FR)", Cache: "Cache (FR)" },
  styleRules: [{ category: "tone", instruction: "Use the formal register." }],
  notes: "Keep it short.",
};

const sentTerms = (text: string, matchInflections?: boolean) => {
  const selected = selectGlossaryForText(glossary, text, { matchInflections });
  return [...selected.glossary.doNotTranslate, ...Object.keys(selected.glossary.preferredTranslations)];
};

describe("selectGlossaryForText", () => {
  it.each([
    ["Use the api today", ["API"]],
    ["Rapid scaling and Precache", []],
    ["Meet {{ps_1}}Cloudflare\nAccess{{ps_2}}", ["Cloudflare Access", "Access"]],
    ["Accessibility for Workers", []],
    ["Built on ASP.NET and .NET 8", [".NET"]],
    ["Cache-Control and the Worker.", ["Worker", "Cache"]],
  ])("matches whole terms only: %s", (text, expected) => {
    expect(sentTerms(text)).toEqual(expected);
  });

  it("lets letters follow a term with matchInflections", () => {
    expect(sentTerms("Accessibility for Workers", true)).toEqual(["Access", "Worker"]);
  });

  it("keeps style rules and notes, and counts what it sent", () => {
    const selected = selectGlossaryForText(glossary, "The API");
    expect(selected.glossary).toMatchObject({ styleRules: glossary.styleRules, notes: "Keep it short." });
    expect(selected.stats).toEqual({ totalTerms: 6, sentTerms: 1, sentCharacters: 3 });
  });
});

describe("translateSegments glossary and prompt ceiling", () => {
  const base = { glossary, sourceLocale: "en", targetLocale: "fr" };
  const echo = (systems: string[]): Translator => ({
    modelId: "echo",
    async translate(system, user) {
      systems.push(system);
      return [...user.matchAll(/^@@([^@\n]+?)@@$/gm)].map(([, id]) => `@@${id}@@\nFR`).join("\n\n");
    },
  });

  it("sends each batch only the terms in its segments or document context", async () => {
    const systems: string[] = [];
    await translateSegments({
      ...base,
      translator: echo(systems),
      segments: [{ id: "a", text: "Try the API" }],
      documentContext: "A page about Cache",
    });
    expect(systems[0]).toContain("- API");
    expect(systems[0]).toContain("- Cache -> Cache (FR)");
    expect(systems[0]).not.toContain("Accès");
    expect(systems[0]).toContain("Use the formal register.");
  });

  it("splits a batch whose whole prompt is over maxPromptTokens, and fails when one segment is", async () => {
    const systems: string[] = [];
    const segments = ["a", "b", "c", "d"].map((id) => ({ id, text: "x".repeat(800) }));
    const result = await translateSegments({ ...base, translator: echo(systems), segments, maxPromptTokens: 450 });
    expect(result.batchCount).toBe(4);
    expect(result.translations.size).toBe(4);

    const rejected = translateSegments({ ...base, translator: echo([]), segments: [segments[0]!], maxPromptTokens: 100 });
    await expect(rejected).rejects.toBeInstanceOf(PromptTooLargeError);
    await expect(rejected).rejects.toThrow(/prompt for segment "a" is about \d+ tokens, over maxPromptTokens \(100\)/);
  });
});
