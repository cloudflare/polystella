import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorMessage } from "../src/admin/components/ErrorMessage/ErrorMessage.js";
import { UsageTooltip } from "../src/admin/components/PageHeader/PageHeader.js";
import { TranslationProgress } from "../src/admin/components/TranslationProgress/TranslationProgress.js";
import { usageTooltipText } from "../src/admin/utils.js";
import { TranslationDebugView } from "../src/admin/components/TranslationDebugView/TranslationDebugView.js";
import { addTranslationUsage, type TranslationDebugAttempt, type TranslationDebugTrace, type TranslationUsage } from "../src/contracts.js";

const attempt = (overrides: Partial<TranslationDebugAttempt>): TranslationDebugAttempt => ({
  attempt: 1,
  durationMs: 1200,
  systemPrompt: "SYSTEM TEXT",
  userPrompt: "USER TEXT",
  response: null,
  translations: null,
  error: null,
  ...overrides,
});

const trace: TranslationDebugTrace = {
  id: "debug-1",
  operation: "content",
  provider: "workers-ai-binding",
  model: "model-a",
  requestInput: null,
  maxOutputTokens: 8192,
  inputTokenBudget: 4000,
  maxSegmentsPerBatch: null,
  sourceLocale: "en",
  targetLocale: "fr",
  batchCount: 1,
  providerCallCount: 2,
  durationMs: 2500,
  error: null,
  validationIssues: [],
  batches: [
    {
      batch: 1,
      segmentCount: 2,
      segmentIds: ["a", "b"],
      segmentLabels: ["title", "body"],
      sourceCharacters: 120,
      estimatedInputTokens: 900,
      attempts: [attempt({ error: "Bad JSON" }), attempt({ attempt: 2, response: "{}", translations: { a: "Bonjour" } })],
    },
  ],
};

describe("shared admin components", () => {
  it("announces errors", () => {
    expect(renderToStaticMarkup(createElement(ErrorMessage, null, "Nope"))).toContain('role="alert"');
  });

  it("lists debug facts as labelled values and shows the last attempt's prompts in tabs", () => {
    const html = renderToStaticMarkup(createElement(TranslationDebugView, { trace, onDismiss: () => {} }));

    expect(html).toContain("<dt");
    expect(html).toContain("Diagnostic ID");
    expect(html).not.toContain(" | ");
    expect(html).toContain("Attempt 1 (failed)");
    expect(html).toContain("Attempt 2");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain("SYSTEM TEXT");
    expect(html).toContain("Parsed");
    expect(html).not.toContain(">Error<");
  });
});

describe("token usage tooltips", () => {
  const usage: TranslationUsage = {
    calls: 3,
    inputTokens: 12_400,
    cachedInputTokens: 2_000,
    outputTokens: 3_100,
    reasoningTokens: 800,
    unreportedCalls: 0,
    estimatedCostUsd: 0.003_14,
  };

  it("puts tokens first, then the list-price estimate", () => {
    expect(usageTooltipText(usage)).toBe("15,500 tokens: 12,400 in (2,000 cached), 3,100 out (800 reasoning). Cost estimate: $0.0031.");
    expect(usageTooltipText({ ...usage, cachedInputTokens: 0, reasoningTokens: 0, estimatedCostUsd: 1.234 })).toBe(
      "15,500 tokens: 12,400 in, 3,100 out. Cost estimate: $1.23.",
    );
    expect(usageTooltipText({ ...usage, estimatedCostUsd: 0 })).toContain("Cost estimate: $0.00.");
  });

  it("says when the price is unknown and which calls reported nothing", () => {
    const { estimatedCostUsd: _cost, ...unpriced } = usage;
    expect(usageTooltipText({ ...unpriced, unreportedCalls: 1 })).toBe(
      "15,500 tokens: 12,400 in (2,000 cached), 3,100 out (800 reasoning). Cost estimate: unknown, a model used has no list price. 1 call reported no token counts and isn't included.",
    );
    const silent = { calls: 2, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, unreportedCalls: 2 };
    expect(usageTooltipText(silent)).toBe("The model didn't report token counts, so usage and cost are unknown.");
  });

  it("adds usages, and drops the cost once a side used tokens without a price", () => {
    const { estimatedCostUsd: _cost, ...unpriced } = usage;
    expect(addTranslationUsage(usage, usage)).toMatchObject({ calls: 6, inputTokens: 24_800, estimatedCostUsd: 0.006_28 });
    expect(addTranslationUsage(usage, unpriced)).not.toHaveProperty("estimatedCostUsd");
    expect(addTranslationUsage(undefined, usage)).toBe(usage);
  });

  it("formats sub-cent costs to two significant digits and larger ones to cents", () => {
    const cost = (estimatedCostUsd: number) => usageTooltipText({ ...usage, estimatedCostUsd });
    expect(cost(0.0099)).toContain("Cost estimate: $0.0099.");
    expect(cost(0.000_31)).toContain("Cost estimate: $0.00031.");
    expect(cost(0.01)).toContain("Cost estimate: $0.01.");
    expect(cost(0.014)).toContain("Cost estimate: $0.01.");
    expect(cost(1234.5)).toContain("Cost estimate: $1,234.50.");
  });

  it("says the cost is unknown when some calls reported tokens, but not when none did", () => {
    const { estimatedCostUsd: _cost, ...unpriced } = usage;
    expect(usageTooltipText(unpriced)).toContain("Cost estimate: unknown, a model used has no list price.");
    expect(usageTooltipText({ ...unpriced, calls: 2, unreportedCalls: 2, inputTokens: 0, outputTokens: 0 })).not.toContain("Cost estimate");
  });

  it("keeps the cost when one side only has calls without token counts", () => {
    const silent = { calls: 1, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, unreportedCalls: 1 };
    expect(addTranslationUsage(usage, silent)).toMatchObject({ calls: 4, unreportedCalls: 1, estimatedCostUsd: 0.003_14 });
    expect(addTranslationUsage(silent, usage)).toMatchObject({ calls: 4, unreportedCalls: 1, estimatedCostUsd: 0.003_14 });
    expect(addTranslationUsage(silent, silent)).not.toHaveProperty("estimatedCostUsd");
  });

  it("drops the cost when the unpriced side is the later one, and ignores a missing second usage", () => {
    const { estimatedCostUsd: _cost, ...unpriced } = usage;
    expect(addTranslationUsage(unpriced, usage)).not.toHaveProperty("estimatedCostUsd");
    expect(addTranslationUsage(usage, undefined)).toBe(usage);
    expect(addTranslationUsage(undefined, undefined)).toBeUndefined();
  });

  it("shows the finished badge by how many translations failed", () => {
    const html = (failures?: "some" | "all", percent = 100) =>
      renderToStaticMarkup(
        createElement(TranslationProgress, { percent, label: "Translate", ...(failures === undefined ? {} : { failures }) }),
      );
    expect(html()).toContain("Done</");
    expect(html(undefined, 50)).not.toContain("Done</");
    expect(html()).toContain("#1e8e3e");
    expect(html("some")).toContain("Some failed");
    expect(html("some")).toContain("--color-kumo-warning");
    expect(html("all")).toContain("Failed</");
    expect(html("all")).toContain("--color-kumo-danger");
    expect(html("all")).not.toContain("Some failed");
    // Failures show nothing, and keep the brand colour, until the run is finished.
    expect(html("all", 50)).not.toContain("Failed</");
    expect(html("all", 50)).toContain("--color-kumo-brand");
  });

  it("wraps the existing text in a focusable trigger, and leaves it plain without usage", () => {
    expect(renderToStaticMarkup(createElement(UsageTooltip, { usage, children: "3/3" }))).toMatch(
      /<button[^>]*type="button"[^>]*>3\/3<\/button>/,
    );
    expect(renderToStaticMarkup(createElement(UsageTooltip, { usage, children: "3/3" }))).toContain('aria-label="3/3. 15,500 tokens');
    expect(renderToStaticMarkup(createElement(UsageTooltip, { usage: undefined, children: "3/3" }))).toBe("3/3");
    const progress = renderToStaticMarkup(
      createElement(TranslationProgress, { percent: 100, label: "Done", detail: "2 drafts created", usage }),
    );
    expect(progress).toMatch(/<button[^>]*>2 drafts created<\/button>/);
  });

  it("gives a debug attempt's token counts a cost tooltip", () => {
    const priced = attempt({ providerResponse: { inputTokens: 10, outputTokens: 5 }, estimatedCostUsd: 0.000_02 });
    const html = renderToStaticMarkup(
      createElement(TranslationDebugView, {
        trace: { ...trace, batches: [{ ...trace.batches[0]!, attempts: [priced] }] },
        onDismiss: () => {},
      }),
    );
    expect(html).toMatch(/<button[^>]*>input 10 tokens · output 5 tokens<\/button>/);
  });
});
