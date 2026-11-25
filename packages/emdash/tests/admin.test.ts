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
  panelErrorMessage,
  sourceContainsTokens,
  TranslationProgress,
  storeTranslationDebug,
  takeTranslationDebug,
} from "../src/admin.js";
import { panelIsVisible } from "../src/admin/panels/ContentEditorPanel.js";
import { keyWithinGroup } from "../src/admin/plugin-page/tabs/CatalogTab/helpers.js";
import {
  contentTypeUrl,
  defaultSubFields,
  isPolicyField,
  isSettingsTab,
  localeLabel,
  plural,
  pluginPageUrl,
  rememberLocaleTags,
  translatableSubFields,
} from "../src/admin/utils.js";
import type { SchemaField } from "../src/admin/types.js";
import type { CatalogEntryView, CatalogGroupView, TranslationDebugTrace } from "../src/contracts.js";
import type { ReactElement } from "react";

afterEach(() => vi.unstubAllGlobals());

describe("EmDash admin entry", () => {
  it("exports the declared pages and editor panel", () => {
    expect(Object.keys(pages)).toEqual(["/", "/settings", "/catalog", "/batch-translation", "/batch-run", "/code-defaults"]);
    expect(contentEditorPanels).toHaveLength(1);
    expect(contentEditorPanels[0]).toMatchObject({ id: "polystella", title: "PolyStella", minRole: 40 });
  });

  it("builds plugin page links and reads the settings tab from the URL", () => {
    expect(pluginPageUrl("/settings", { tab: "translation" })).toBe("/_emdash/admin/plugins/polystella/settings?tab=translation");
    expect(pluginPageUrl("/code-defaults")).toBe("/_emdash/admin/plugins/polystella/code-defaults");
    expect(contentTypeUrl("blog posts")).toBe("/_emdash/admin/content-types/blog%20posts");
    expect(["translation", "collections", "sandbox", "catalog", null].map(isSettingsTab)).toEqual([true, true, true, false, false]);
  });

  it("pluralizes counts", () => {
    expect([1, 0, 2].map((count) => plural(count, "entry", "entries"))).toEqual(["1 entry", "0 entries", "2 entries"]);
    expect(plural(3, "key")).toBe("3 keys");
    expect(plural(1234, "key")).toBe(`${(1234).toLocaleString()} keys`);
  });

  it("drops the group prefix from catalog keys only when the group names it", () => {
    expect(keyWithinGroup("ai_translation_notice.title", "ai_translation_notice")).toBe("title");
    expect(keyWithinGroup("ai_translation_notice", "ai_translation_notice")).toBe("ai_translation_notice");
    expect(keyWithinGroup("ai_translation_noticeboard.title", "ai_translation_notice")).toBe("ai_translation_noticeboard.title");
  });

  it("shows the editor panel only for enabled collections, and still on a failed policy read", async () => {
    const policy = (response: Response) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
    const context = { collection: "posts", entry: { id: "e1" } } as Parameters<typeof panelIsVisible>[0];

    expect(contentEditorPanels[0]?.isVisible).toBe(panelIsVisible);
    policy(Response.json({ data: { enabled: true } }));
    await expect(panelIsVisible(context)).resolves.toBe(true);
    policy(Response.json({ data: { enabled: false } }));
    await expect(panelIsVisible(context)).resolves.toBe(false);
    policy(Response.json({ error: { message: "boom" } }, { status: 500 }));
    await expect(panelIsVisible(context)).resolves.toBe(true);
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
    expect(sourceContainsTokens("Hello {name}", "icu")).toBe(true);
    expect(sourceContainsTokens("{n, plural, other {# x}}", "icu")).toBe(true);
    expect(sourceContainsTokens("Use '{'braces'}'", "icu")).toBe(false);
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

  it("tells editors apart a lock takeover from a stale revision", () => {
    const lock = { userId: "user-2", userName: "Ada", acquiredAt: "2026-09-24T00:00:00Z", expiresAt: "2026-09-24T00:05:00Z" };
    expect(panelErrorMessage(new ApiResponseError(409, "ENTRY_LOCKED", "Entry is locked", lock))).toContain("Ada is editing this entry");
    expect(panelErrorMessage(new ApiResponseError(409, "CONFLICT", "Revision mismatch"))).toContain("changed while PolyStella");
    expect(panelErrorMessage(new ApiResponseError(409, "CONFLICT", "Translation already exists"), "fr")).toContain(
      "A fr translation already exists",
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

  it("labels locales with the language name and code", () => {
    expect(localeLabel("fr")).toContain("(fr)");
    expect(localeLabel("fr", "fr-FR")).toMatch(/\(fr, fr-FR\)$/);
    expect(localeLabel("not a tag!")).toBe("not a tag!");
  });

  it("names a locale from its localeTags tag and keeps the code", () => {
    const literal = localeLabel("es-la");
    rememberLocaleTags({ "es-la": "es-419" });
    const label = localeLabel("es-la");
    expect(label).not.toBe(literal);
    expect(label).toBe(`${new Intl.DisplayNames(undefined, { type: "language" }).of("es-419")} (es-la)`);
    expect(localeLabel("ES-LA")).toMatch(/\(ES-LA\)$/);
  });

  describe("repeater subfields", () => {
    const repeater = {
      slug: "faq",
      type: "repeater",
      validation: {
        subFields: [
          { slug: "question", type: "string", label: "Question" },
          { slug: "answer", type: "text" },
          { slug: "image", type: "image", label: "Image" },
          { slug: "link", type: "url", label: "Link" },
        ],
      },
    } as unknown as SchemaField;

    it("picks the text and image subfields", () => {
      expect(translatableSubFields(repeater)).toEqual([
        { slug: "question", label: "Question" },
        { slug: "answer", label: "answer" },
        { slug: "image", label: "Image" },
      ]);
      expect(translatableSubFields({ slug: "t", type: "string" } as unknown as SchemaField)).toEqual([]);
      expect(translatableSubFields({ slug: "faq", type: "repeater" } as unknown as SchemaField)).toEqual([]);
    });

    it("starts a repeater without its links, ids and author names", () => {
      const subFields = ["question", "url", "author_name", "slug", "ctaHref", "link", "link_text", "author_bio", "key_points", "image"];
      const withCopied = {
        ...repeater,
        validation: { subFields: subFields.map((slug) => ({ slug, type: slug === "image" ? "image" : "string" })) },
      } as unknown as SchemaField;
      expect(defaultSubFields(withCopied)).toEqual(["question", "link_text", "author_bio", "key_points", "image"]);
      const onlyCopied = { ...repeater, validation: { subFields: [{ slug: "url", type: "string" }] } } as unknown as SchemaField;
      expect(defaultSubFields(onlyCopied)).toEqual([]);
    });

    it("needs a chosen translatable subfield before a repeater counts as a policy field", () => {
      expect(isPolicyField(repeater, { fields: ["faq"] })).toBe(false);
      expect(isPolicyField(repeater, { fields: ["faq"], subFields: { faq: ["link", "gone"] } })).toBe(false);
      expect(isPolicyField(repeater, { fields: ["faq"], subFields: { faq: ["question"] } })).toBe(true);
      expect(isPolicyField(repeater, { fields: [], subFields: { faq: ["question"] } })).toBe(false);
    });
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
    requestInput: null,
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
