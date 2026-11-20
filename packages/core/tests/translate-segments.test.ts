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

  it("runs up to `concurrency` batches at once and cancels the rest after a failure", async () => {
    const groups = ["a", "b", "c", "d"].map((id) => [segment(id, "hello world")]);
    let inFlight = 0;
    let peak = 0;
    const signals: AbortSignal[] = [];
    const translator: Translator = {
      modelId: "stub/slow",
      async translate(_systemPrompt, userPrompt, signal) {
        const id = /^@@([^@\n]+?)@@/m.exec(userPrompt)?.[1] ?? "";
        if (signal !== undefined) signals.push(signal);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (id === "b") throw new PermanentProviderError("bad request");
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return responseFor([id]);
      },
    };

    await expect(
      translateSegments({ ...commonOptions, translator, segments: groups.flat(), groups, inputTokenBudget: 4, concurrency: 2 }),
    ).rejects.toThrow("bad request");
    expect(peak).toBe(2);
    // "a" was in flight when "b" failed; "c" and "d" never started.
    expect(signals).toHaveLength(2);
    expect(signals.every((batchSignal) => batchSignal.aborted)).toBe(true);

    const echo = makeEchoTranslator();
    const translated = await translateSegments({
      ...commonOptions,
      translator: echo,
      segments: groups.flat(),
      groups,
      inputTokenBudget: 4,
      concurrency: 3,
    });
    expect(translated.batchCount).toBe(4);
    expect([...translated.translations.keys()].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects groups that omit segments", async () => {
    const translator = makeEchoTranslator();
    const segments = [segment("a", "hello"), segment("b", "world")];

    await expect(translateSegments({ ...commonOptions, translator, segments, groups: [[segments[0]!]] })).rejects.toThrow(
      "flat(groups) must equal segments",
    );
    expect(translator.calls).toHaveLength(0);
  });

  it("rejects duplicate IDs across batches", async () => {
    const translator = makeEchoTranslator();
    const segments = [segment("same", "first"), segment("same", "second")];

    await expect(translateSegments({ ...commonOptions, translator, segments, groups: [[segments[0]!], [segments[1]!]] })).rejects.toThrow(
      'duplicate segment id "same"',
    );
    expect(translator.calls).toHaveLength(0);
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
