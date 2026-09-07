import { ApiResponseError } from "@emdash-cms/admin";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogOverrideChanged,
  contentEditorPanels,
  formatErrorDetails,
  groupCatalogEntries,
  isTranslationDebugTrace,
  pages,
  storeTranslationDebug,
  takeTranslationDebug,
} from "../src/admin.js";
import type { CatalogEntryView, TranslationDebugTrace } from "../src/contracts.js";

afterEach(() => vi.unstubAllGlobals());

describe("EmDash admin entry", () => {
  it("exports the declared pages and editor panel", () => {
    expect(Object.keys(pages)).toEqual(["/"]);
    expect(contentEditorPanels).toHaveLength(1);
    expect(contentEditorPanels[0]).toMatchObject({ id: "polystella", title: "PolyStella", minRole: 40 });
  });

  it("groups catalog entries by their first key segment", () => {
    const entries = [catalogEntry("a11y.skip"), catalogEntry("a11y.new_tab"), catalogEntry("header.nav.home")];

    expect(groupCatalogEntries(entries)).toEqual([
      { name: "a11y", entries: entries.slice(0, 2) },
      { name: "header", entries: entries.slice(2) },
    ]);
  });

  it("classifies override toggle changes", () => {
    expect(catalogOverrideChanged(null, false, "")).toBe(false);
    expect(catalogOverrideChanged(null, true, "")).toBe(true);
    expect(catalogOverrideChanged("saved", true, "saved")).toBe(false);
    expect(catalogOverrideChanged("saved", false, "saved")).toBe(true);
  });

  it("formats request failures for the error details disclosure", () => {
    expect(formatErrorDetails(new ApiResponseError(500, "INTERNAL_ERROR", "Plugin route error", { operation: "content" }))).toBe(
      'HTTP status: 500\nCode: INTERNAL_ERROR\nMessage: Plugin route error\nDetails: {\n  "operation": "content"\n}',
    );
  });

  it("validates restored browser debug traces", () => {
    expect(isTranslationDebugTrace(debugTrace())).toBe(true);
    expect(isTranslationDebugTrace({ operation: "content", batches: [{}] })).toBe(false);
  });

  it("restores a debug trace once for the same administrator", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    const trace = debugTrace();

    storeTranslationDebug("posts", "entry-1", "fr-FR", "admin-1", trace);

    expect(takeTranslationDebug("posts", "entry-1", "fr-FR", "editor-1")).toBeNull();
    expect(takeTranslationDebug("posts", "entry-1", "fr-FR", "admin-1")).toEqual(trace);
    expect(takeTranslationDebug("posts", "entry-1", "fr-FR", "admin-1")).toBeNull();
  });
});

function catalogEntry(key: string): CatalogEntryView {
  return { key, source: "Source", deployed: "Deployed", override: null, state: null };
}

function debugTrace(): TranslationDebugTrace {
  return {
    id: "debug-1",
    operation: "content",
    provider: "workers-ai-binding",
    model: "model-a",
    maxOutputTokens: 8192,
    inputTokenBudget: 4000,
    maxSegmentsPerBatch: null,
    sourceLocale: "en-US",
    targetLocale: "fr-FR",
    batchCount: 0,
    providerCallCount: 0,
    durationMs: 1,
    error: null,
    validationIssues: [],
    batches: [],
  };
}
