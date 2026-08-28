import { describe, expect, it, vi } from "vitest";

import { EMPTY_GLOSSARY, PermanentProviderError, translateSegments, type Segment, type Translator } from "../src/index.js";

const segment = (id: string, text: string): Segment => ({ id, text });

function responseFor(ids: string[]): string {
  return ids.map((id) => `@@${id}@@\nTR:${id}`).join("\n\n");
}

function makeEchoTranslator(): Translator & { calls: string[][]; systemPrompts: string[] } {
  const translator = {
    modelId: "stub/echo",
    calls: [] as string[][],
    systemPrompts: [] as string[],
    async translate(systemPrompt: string, userPrompt: string) {
      const ids = [...userPrompt.matchAll(/^@@([^@\n]+?)@@\s*$/gm)].map((match) => match[1]!.trim());
      translator.calls.push(ids);
      translator.systemPrompts.push(systemPrompt);
      return responseFor(ids);
    },
  };
  return translator;
}

const commonOptions = {
  glossary: EMPTY_GLOSSARY,
  sourceLocale: "en-US",
  targetLocale: "pt-BR",
};

describe("translateSegments", () => {
  it("uses one batch by default and short-circuits empty input", async () => {
    const translator = makeEchoTranslator();
    const translated = await translateSegments({
      ...commonOptions,
      translator,
      segments: [segment("a", "alpha"), segment("b", "beta")],
    });
    expect(translator.calls).toEqual([["a", "b"]]);
    expect(translated.batchCount).toBe(1);
    expect([...translated.translations]).toEqual([
      ["a", "TR:a"],
      ["b", "TR:b"],
    ]);

    const empty = await translateSegments({ ...commonOptions, translator, segments: [] });
    expect(empty).toEqual({ translations: new Map(), batchCount: 0 });
    expect(translator.calls).toHaveLength(1);
  });

  it("dispatches forced batches sequentially and merges results", async () => {
    const translator = makeEchoTranslator();
    const first = [segment("a", "hello"), segment("b", "world")];
    const second = [segment("c", "hello"), segment("d", "world")];
    const translated = await translateSegments({
      ...commonOptions,
      translator,
      segments: [...first, ...second],
      groups: [first, second],
      inputTokenBudget: 7,
    });
    expect(translator.calls).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(translated.batchCount).toBe(2);
    expect([...translated.translations.keys()]).toEqual(["a", "b", "c", "d"]);
  });

  it("adds document context to every batch", async () => {
    const translator = makeEchoTranslator();
    const groups = [[segment("a", "hello")], [segment("b", "world")]];
    await translateSegments({
      ...commonOptions,
      translator,
      segments: groups.flat(),
      groups,
      inputTokenBudget: 4,
      documentContext: "Title: Example",
    });
    expect(translator.systemPrompts).toHaveLength(2);
    expect(translator.systemPrompts.every((prompt) => prompt.includes("DOCUMENT CONTEXT") && prompt.includes("Title: Example"))).toBe(true);
  });

  it("keeps retries inside the failing batch", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(responseFor(["a"]))
      .mockResolvedValueOnce(responseFor(["b"]));
    const groups = [[segment("a", "first")], [segment("b", "second")]];
    const translated = await translateSegments({
      ...commonOptions,
      translator: { modelId: "stub/retry", translate },
      segments: groups.flat(),
      groups,
      inputTokenBudget: 4,
      maxRetries: 1,
    });
    expect(translate).toHaveBeenCalledTimes(3);
    expect(translated.batchCount).toBe(2);
  });

  it("stops before later batches after a permanent failure", async () => {
    const translate = vi.fn().mockRejectedValue(new PermanentProviderError("401"));
    const groups = [[segment("a", "first")], [segment("b", "second")]];
    await expect(
      translateSegments({
        ...commonOptions,
        translator: { modelId: "stub/permanent", translate },
        segments: groups.flat(),
        groups,
        inputTokenBudget: 4,
        maxRetries: 2,
      }),
    ).rejects.toThrow("401");
    expect(translate).toHaveBeenCalledOnce();
  });

  it("honors cancellation before and between batches", async () => {
    const before = new AbortController();
    before.abort(new Error("cancelled"));
    const translator = makeEchoTranslator();
    await expect(
      translateSegments({ ...commonOptions, translator, segments: [segment("a", "first")], signal: before.signal }),
    ).rejects.toThrow();
    expect(translator.calls).toHaveLength(0);

    const between = new AbortController();
    const translate = vi.fn().mockImplementationOnce(async () => {
      between.abort(new Error("cancelled"));
      return responseFor(["a"]);
    });
    const groups = [[segment("a", "first")], [segment("b", "second")]];
    await expect(
      translateSegments({
        ...commonOptions,
        translator: { modelId: "stub/abort", translate },
        segments: groups.flat(),
        groups,
        inputTokenBudget: 4,
        signal: between.signal,
      }),
    ).rejects.toThrow();
    expect(translate).toHaveBeenCalledOnce();
  });
});
