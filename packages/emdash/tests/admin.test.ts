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
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CollapsibleCard } from "../src/admin/components/CollapsibleCard/CollapsibleCard.js";
import { InfoLabel } from "../src/admin/components/PageHeader/PageHeader.js";
import { stepProgress } from "../src/admin/components/TranslationProgress/TranslationProgress.js";
import { saveTranslationSettings } from "../src/admin/plugin-page/tabs/TranslationSettingsTab/TranslationSettingsTab.js";
import type { BatchJobView, TranslationSettingsResponse } from "../src/contracts.js";
import { BatchJobs } from "../src/admin/plugin-page/tabs/BatchTab/BatchJobs.js";
import { translatedIn } from "../src/admin/plugin-page/tabs/SandboxTab/SandboxTab.js";

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

  it("sorts catalog groups alphabetically by title, or by key when there is no title", () => {
    const entries = [catalogEntry("zeta.a"), catalogEntry("blocks.a"), catalogEntry("ai_notice.a")];
    const groups: CatalogGroupView[] = [
      { key: "zeta", title: "Article" },
      { key: "ai_notice", title: "AI Translation Notice" },
    ];
    expect(groupCatalogEntries(entries, groups).map((group) => group.key)).toEqual(["ai_notice", "zeta", "blocks"]);
  });

  it("sorts catalog groups ignoring case and keeps equal names in first-seen order", () => {
    const entries = [catalogEntry("b.x"), catalogEntry("B.x"), catalogEntry("a.x"), catalogEntry("C.x")];
    const groups: CatalogGroupView[] = [
      { key: "b", title: "Same" },
      { key: "B", title: "same" },
    ];
    expect(groupCatalogEntries(entries, groups).map((group) => group.key)).toEqual(["a", "C", "b", "B"]);
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

  it("renders a collapsible card toggle only when it has a body, and hides the body when closed", () => {
    const card = (open: boolean, children?: ReactElement | null) =>
      renderToStaticMarkup(createElement(CollapsibleCard, { header: "Pages", label: "Pages", open, onOpenChange: () => {} }, children));
    const body = createElement("p", null, "Body text");

    expect(card(true)).not.toContain("<button");
    expect(card(true, null)).not.toContain("<button");
    expect(card(false, body)).toContain('aria-label="Expand Pages"');
    expect(card(false, body)).not.toContain("Body text");
    expect(card(true, body)).toContain('aria-label="Collapse Pages"');
    expect(card(true, body)).toContain("Body text");
  });

  it("renders an info label with its text and an 'About' button", () => {
    const html = renderToStaticMarkup(createElement(InfoLabel, { label: "Max tokens", info: "Output limit" }));

    expect(html).toContain("Max tokens");
    expect(html).toContain('aria-label="About Max tokens"');
    expect(html).toContain("<button");
  });

  describe("BatchJobs", () => {
    const createdAt = "2026-03-04T15:30:00.000Z";
    const startedAt = new Date(createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const job = (overrides: Partial<BatchJobView> = {}): BatchJobView => ({
      id: "job-1",
      collection: "posts",
      locales: ["fr", "de"],
      total: 4,
      status: "finished",
      createdAt,
      publish: false,
      updateExisting: false,
      listing: false,
      truncated: false,
      entryCount: 2,
      counts: { created: 2, updated: 1, skipped: 1, failed: 0 },
      settings: null,
      retryOf: null,
      ...overrides,
    });
    const render = (view: BatchJobView) =>
      renderToStaticMarkup(
        createElement(BatchJobs, { jobs: [view], collectionLabels: { posts: "Blog posts" }, urlContexts: {}, onChange: () => {} }),
      );

    it("titles a job with its collection label and formatted start time", () => {
      expect(render(job())).toContain(`Blog posts · ${startedAt}`);
      expect(
        renderToStaticMarkup(createElement(BatchJobs, { jobs: [job()], collectionLabels: {}, urlContexts: {}, onChange: () => {} })),
      ).toContain(`posts · ${startedAt}`);
    });

    it("shows the status badge for each job state", () => {
      const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
      expect(render(job({ status: "running", total: 4, counts }))).toContain("Running");
      expect(render(job())).toContain("Finished<");
      expect(render(job({ counts: { created: 1, updated: 0, skipped: 0, failed: 3 } }))).toContain("Finished, 3 failed");
      expect(render(job({ status: "cancelled" }))).toContain("Cancelled");
    });

    it("collapses more than 3 locales into a count", () => {
      const html = render(job({ locales: ["fr", "de", "es", "it", "pt"] }));
      expect(html).toContain("5 locales");
      // The names stay out of the visible text, but screen readers get them in the label.
      expect(html.replace(/aria-label="[^"]*"/g, "")).not.toContain(localeLabel("pt"));
      expect(html).toContain(`aria-label="5 locales: `);
      expect(render(job({ locales: ["fr", "de", "es"] }))).not.toContain("3 locales");
    });

    it("starts a running job expanded with tabs and a finished job collapsed", () => {
      const running = render(job({ status: "running" }));
      expect(running).toContain('aria-expanded="true"');
      expect(running).toContain('role="tablist"');
      expect(running).toContain("Entries (2)");
      expect(running).toContain("Results (4)");

      const finished = render(job());
      expect(finished).toContain('aria-expanded="false"');
      expect(finished).not.toContain('role="tablist"');
    });

    it("summarises outcome counts in the bar's aria-label", () => {
      expect(render(job())).toContain('aria-label="4 of 4 done: 2 created, 1 updated, 1 skipped, 0 failed"');
    });

    // Entry links need effects and a router, which static rendering lacks; not covered here.
  });

  it("saves only the editable translation settings fields", async () => {
    const settings: TranslationSettingsResponse = {
      defaultLocale: "en",
      localeTags: {},
      revision: "rev-1",
      debugEnabled: true,
      maxTokens: 4096,
      defaultMaxTokens: 8192,
      clearAiFlagOnEdit: true,
      translateSeoWhenPublished: false,
      model: "m1",
      reasoning: "high",
      defaultModel: "m0",
      allowedModels: ["m1"],
      locales: [
        {
          locale: "fr",
          defaultModel: "m0",
          model: "m1",
          reasoning: "low",
          defaultReasoning: null,
          defaultGlossary: null,
          defaultGlossarySource: null,
          glossaryMode: "append",
          glossaryText: "mine",
        },
      ],
      instructions: { defaultText: "code instructions", mode: "replace", text: "custom" },
    };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: settings }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveTranslationSettings(settings)).resolves.toEqual(settings);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("settings/translation");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      revision: "rev-1",
      debugEnabled: true,
      maxTokens: 4096,
      clearAiFlagOnEdit: true,
      translateSeoWhenPublished: false,
      model: "m1",
      reasoning: "high",
      locales: { fr: { model: "m1", reasoning: "low", glossaryMode: "append", glossaryText: "mine" } },
      instructions: { mode: "replace", text: "custom" },
    });
  });

  it("renders an accessible progress bar with a step list", () => {
    const html = renderToStaticMarkup(
      createElement(TranslationProgress, stepProgress(["Loading entry", "Translating", "Saving"], 1, "Translating selected fields")),
    );
    expect(html).not.toContain("<progress");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-label="Translating selected fields"');
    expect(html).toMatch(/aria-current="step"[^>]*>.*Translating</);
    expect(html).not.toContain("Done");
    expect(html).not.toContain('role="status"');
  });

  it("says a very fast sandbox translation took under 0.1 s", () => {
    expect(translatedIn(40)).toBe("Translated in under 0.1 s");
    expect(translatedIn(1250)).toMatch(/^Translated in 1[.,][23] s$/);
  });

  it("computes step progress from the step and its fraction", () => {
    const steps = ["a", "b", "c", "d"];
    expect(stepProgress(steps, 0, "A")).toEqual({ steps, step: 0, label: "A", percent: 13 });
    expect(stepProgress(steps, 3, "D", { fraction: 1 }).percent).toBe(100);
    expect(stepProgress(steps, 1, "B", { fraction: 0, detail: "2 of 4" })).toMatchObject({ percent: 25, detail: "2 of 4" });
    expect(stepProgress(steps, 1, "B")).not.toHaveProperty("detail");
  });

  it("shows a single-label progress with counts, and a Done badge when complete", () => {
    const running = renderToStaticMarkup(
      createElement(TranslationProgress, { percent: 40, label: "Generating", detail: "40 of 100 keys · batch 2 of 5" }),
    );
    expect(running).toContain("Generating");
    expect(running).toContain("40 of 100 keys · batch 2 of 5");
    expect(running).toContain('aria-valuetext="40%: Generating, 40 of 100 keys · batch 2 of 5"');
    const done = renderToStaticMarkup(createElement(TranslationProgress, { percent: 100, label: "Catalog generation complete" }));
    expect(done).toContain("Done");
    expect(done).not.toContain('aria-current="step"');
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
