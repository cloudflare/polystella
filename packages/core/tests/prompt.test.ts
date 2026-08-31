import { describe, expect, it } from "vitest";

import { buildPrompt, EMPTY_GLOSSARY, parseResponse, type Glossary, type Segment } from "../src/index.js";

const segments: Segment[] = [
  { id: "fm:title", text: "Hello" },
  { id: "body:0", text: "A paragraph." },
];

const glossary: Glossary = {
  version: "2026-04",
  doNotTranslate: ["Cloudflare", "TLS"],
  preferredTranslations: { edge: "borda" },
  styleRules: [
    { category: "tone", instruction: "Use formal academic register." },
    { category: "numbers", instruction: "Use comma as decimal separator.", example: "21.3 -> 21,3" },
  ],
  notes: "Use Brazilian Portuguese spelling.",
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("buildPrompt", () => {
  it("matches the recorded baseline bytes", async () => {
    const prompt = buildPrompt({
      segments,
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });

    expect(prompt.systemPrompt).toContain("American English (en-US)");
    expect(prompt.systemPrompt).toContain("Brazilian Portuguese (pt-BR)");
    expect(prompt.systemPrompt).not.toContain("markdown");
    expect(await sha256(prompt.systemPrompt)).toBe("85eb85ecc4365b214331beac11ddb345ccb939ec73ff3a8110707839e321d39f");
    expect(await sha256(prompt.userPrompt)).toBe("975ae31980e7f7a782ec257d7584e0ba689b01f006e86c34c82ba029a1363685");
  });

  it("renders glossary sections in order", () => {
    const { systemPrompt } = buildPrompt({
      segments,
      glossary,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    const headings = ["MUST NOT BE TRANSLATED", "PREFERRED TRANSLATIONS", "STYLE RULES", "ADDITIONAL NOTES", "OUTPUT FORMAT"];
    expect(headings.map((heading) => systemPrompt.indexOf(heading))).toEqual(
      [...headings.map((heading) => systemPrompt.indexOf(heading))].sort((left, right) => left - right),
    );
    expect(systemPrompt).toContain("- Cloudflare");
    expect(systemPrompt).toContain("- edge -> borda");
    expect(systemPrompt).toContain("  Example: 21.3 -> 21,3");
  });

  it("threads trimmed site and document context without changing absent-context bytes", () => {
    const baseline = buildPrompt({ segments, glossary, sourceLocale: "en-US", targetLocale: "pt-BR" });
    const absent = buildPrompt({
      segments,
      glossary,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      context: "  ",
      documentContext: "\n",
    });
    expect(absent).toEqual(baseline);

    const framed = buildPrompt({
      segments,
      glossary,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      context: "  Specialise in research.  ",
      documentContext: "  Title: Echo State Networks  ",
    });
    expect(framed.systemPrompt.split("\n")[1]).toBe("Specialise in research.");
    expect(framed.systemPrompt).toContain(
      "DOCUMENT CONTEXT (for terminology only; do not translate this block):\nTitle: Echo State Networks",
    );
  });

  it("includes a trimmed format instruction only when supplied", () => {
    const { systemPrompt } = buildPrompt({
      segments,
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
      promptInstruction: "  Preserve markdown markers.  ",
    });

    expect(systemPrompt).toContain("\nPreserve markdown markers.\n");
  });
});

describe("parseResponse", () => {
  const expectedIds = segments.map((segment) => segment.id);

  it("parses marker blocks and preserves multiline content", () => {
    const response = ["@@fm:title@@", "Ola", "", "@@body:0@@", "First line", "Second line", "", "Third line"].join("\n");
    const parsed = parseResponse(response, expectedIds);
    expect(parsed.get("fm:title")).toBe("Ola");
    expect(parsed.get("body:0")).toBe("First line\nSecond line\n\nThird line");
  });

  it("unwraps code fences and ignores preambles and unknown ids", () => {
    const response = [
      "```text",
      "Here are the translations:",
      "@@unknown@@",
      "ignored",
      "@@fm:title@@",
      "Title",
      "@@body:0@@",
      "Body",
      "```",
    ].join("\n");
    const parsed = parseResponse(response, expectedIds);
    expect([...parsed]).toEqual([
      ["fm:title", "Title"],
      ["body:0", "Body"],
    ]);
  });

  it("rejects missing markers, empty translations, and omitted ids", () => {
    expect(() => parseResponse("plain text", expectedIds)).toThrow(/no segment markers/);
    expect(() => parseResponse("@@fm:title@@\n\n@@body:0@@\nBody", expectedIds)).toThrow(/empty translation/);
    expect(() => parseResponse("@@fm:title@@\nTitle", expectedIds)).toThrow(/omitted segment "body:0"/);
  });

  it("reports likely truncation without dumping an unbounded response", () => {
    const longResponse = `@@fm:title@@\n${"x".repeat(3000)}`;
    expect(() => parseResponse(longResponse, expectedIds)).toThrow(/Response appears truncated.*truncated middle/s);
  });
});
