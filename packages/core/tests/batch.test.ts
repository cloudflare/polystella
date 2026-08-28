import { describe, expect, it, vi } from "vitest";

import { DEFAULT_INPUT_TOKEN_BUDGET, estimateInputTokens, packGroupsIntoBatches, type Segment } from "../src/index.js";

const segment = (id: string, text: string): Segment => ({ id, text });

describe("estimateInputTokens", () => {
  it("pins the current chars-per-token formula", () => {
    expect(estimateInputTokens([])).toBe(0);
    expect(estimateInputTokens([segment("a", "hello")])).toBe(4);
    expect(estimateInputTokens([segment("a", "hello"), segment("b", "world")])).toBe(7);
    expect(DEFAULT_INPUT_TOKEN_BUDGET).toBe(4000);
  });
});

describe("packGroupsIntoBatches", () => {
  it("ignores empty groups and packs fitting groups together", () => {
    const first = [segment("a", "hello")];
    const second = [segment("b", "world")];
    expect(packGroupsIntoBatches([[], first, second, []])).toEqual([[...first, ...second]]);
  });

  it("preserves segment references and order across batches", () => {
    const groups = [
      [segment("a", "hello"), segment("b", "world")],
      [segment("c", "hello"), segment("d", "world")],
    ];
    const batches = packGroupsIntoBatches(groups, { inputTokenBudget: 7 });
    expect(batches).toHaveLength(2);
    expect(batches.flat()).toEqual(groups.flat());
    expect(batches.flat().every((entry, index) => entry === groups.flat()[index])).toBe(true);
  });

  it("warns and splits an oversize group without dropping segments", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const group = [segment("a", "this is much too long"), segment("b", "also too long")];
    const batches = packGroupsIntoBatches([group], { inputTokenBudget: 3, logger, sourcePath: "docs/large.md" });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/docs\/large\.md.*splitting paragraph-by-paragraph/));
    expect(batches.flat()).toEqual(group);
  });

  it("flushes a fitting group before splitting the next oversize group", () => {
    const first = [segment("a", "x")];
    const oversize = [segment("b", "this is the long one"), segment("c", "and another long bit")];
    const batches = packGroupsIntoBatches([first, oversize], { inputTokenBudget: 5 });
    expect(batches[0]).toEqual(first);
    expect(batches.slice(1).flat()).toEqual(oversize);
  });
});
