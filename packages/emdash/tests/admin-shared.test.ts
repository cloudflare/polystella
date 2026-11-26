import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErrorMessage } from "../src/admin/components/ErrorMessage/ErrorMessage.js";
import { TranslationDebugView } from "../src/admin/components/TranslationDebugView/TranslationDebugView.js";
import type { TranslationDebugAttempt, TranslationDebugTrace } from "../src/contracts.js";

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
