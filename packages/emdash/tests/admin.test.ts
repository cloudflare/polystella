import { ApiResponseError } from "@emdash-cms/admin";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogOverrideChanged,
  contentEditorPanels,
  filterCatalogGroups,
  formatErrorDetails,
  groupCatalogEntries,
  isTranslationDebugTrace,
  pages,
  sourceContainsTokens,
  TranslationProgress,
  storeTranslationDebug,
  takeTranslationDebug,
} from "../src/admin.js";
import type { CatalogEntryView, CatalogGroupView, TranslationDebugTrace } from "../src/contracts.js";
import type { ReactElement } from "react";

afterEach(() => vi.unstubAllGlobals());

describe("EmDash admin entry", () => {
  it("exports the declared pages and editor panel", () => {
    expect(Object.keys(pages)).toEqual(["/"]);
    expect(contentEditorPanels).toHaveLength(1);
    expect(contentEditorPanels[0]).toMatchObject({ id: "polystella", title: "PolyStella", minRole: 40 });
  });

  it("groups catalog entries by their first key segment with i18n_group_title labels", () => {
    const entries = [catalogEntry("a11y.skip"), catalogEntry("a11y.new_tab"), catalogEntry("header.nav.home")];
    const groups: CatalogGroupView[] = [
      { key: "a11y", title: "Accessibility" },
      { key: "header", title: null },
    ];

    expect(groupCatalogEntries(entries, groups)).toEqual([
      { key: "a11y", title: "Accessibility", entries: entries.slice(0, 2) },
      { key: "header", title: null, entries: entries.slice(2) },
    ]);
  });

  it("filters catalog groups by group title, group key, or entry keys", () => {
    const groups = groupCatalogEntries(
      [catalogEntry("a11y.skip"), catalogEntry("header.nav.home")],
      [
        { key: "a11y", title: "Accessibility" },
        { key: "header", title: "Navigation" },
      ],
    );

    expect(filterCatalogGroups(groups, "nav")).toEqual([groups[1]]);
    expect(filterCatalogGroups(groups, "access")).toEqual([groups[0]]);
    expect(filterCatalogGroups(groups, "a11y.skip")).toEqual([groups[0]]);
    expect(filterCatalogGroups(groups, "  ")).toEqual(groups);
  });

  it("detects {{token}} placeholders in source text", () => {
    expect(sourceContainsTokens("Hello {{name}}")).toBe(true);
    expect(sourceContainsTokens("Hello {name}")).toBe(false);
    expect(sourceContainsTokens(null)).toBe(false);
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

  it("renders a named native percentage progress indicator", () => {
    type TestElement = ReactElement & {
      props: { children: Array<TestElement | string | unknown>; value?: number; max?: number };
    };
    const el = TranslationProgress({ percent: 45, label: "Translating selected fields" }) as TestElement;
    expect(el.type).toBe("div");
    const children = el.props.children as TestElement[];
    const progress = children[0] as TestElement;
    expect(progress.type).toBe("progress");
    expect(progress.props.value).toBe(45);
    expect(progress.props.max).toBe(100);
    const label = children[1] as TestElement;
    expect(label.type).toBe("small");
    const labelText = (label.props.children as unknown[]).map(String).join("");
    expect(labelText).toBe("45%: Translating selected fields");
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
