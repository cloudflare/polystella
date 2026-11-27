import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  jobSettingsChanges,
  JobSettingsSection,
  jobSettingsError,
  jobSettingsPayload,
  jobSettingsSummary,
} from "../src/admin/components/JobSettings/JobSettings.js";
import { BatchRunPage } from "../src/admin/plugin-page/BatchRunPage.js";
import { RetryForm } from "../src/admin/plugin-page/tabs/BatchTab/RetryForm.js";
import { BatchJobs } from "../src/admin/plugin-page/tabs/BatchTab/BatchJobs.js";
import { BatchResultsTable, type BatchResultRow } from "../src/admin/plugin-page/tabs/BatchTab/BatchResults.js";
import {
  batchRunEndState,
  batchSizeError,
  collectionRunCounts,
  countOutcomes,
  jobsLeft,
  planBatchJobs,
  planRetry,
  selectedRunBlockReason,
  type BatchResult,
} from "../src/admin/plugin-page/tabs/BatchTab/helpers.js";
import { MAX_BATCH_TRANSLATIONS, type BatchJobSettings, type BatchJobView } from "../src/contracts.js";

describe("continuing a stopped browser run", () => {
  it("leaves exactly the planned jobs without a result, in plan order", () => {
    const item = (id: string) => ({ id, title: id, slug: null, locale: "en" });
    const target = (locale: string) => ({ locale, code: locale });
    const planned = planBatchJobs([item("a"), item("b")], [target("fr"), target("de")]);
    const ran = [planned[2], planned[0]].filter((job) => job !== undefined);

    expect(jobsLeft(planned, ran).map((job) => `${job.item.id}:${job.target.locale}`)).toEqual(["a:de", "b:de"]);
    expect(jobsLeft(planned, planned)).toEqual([]);
  });
});

describe("retrying a browser run", () => {
  const item = (id: string) => ({ id, title: id, slug: null, locale: "en" });
  const target = { locale: "fr", code: "fr" };
  const link = (id: string) => ({ id, locale: "fr", slug: null, published: false });
  const planned = planBatchJobs([item("a"), item("b"), item("c")], [target]);
  const result = (id: string, outcome: BatchResult["outcome"], extra: Partial<BatchResult> = {}): BatchResult => ({
    item: item(id),
    target,
    outcome,
    message: null,
    translation: outcome === "failed" ? null : link(`${id}-fr`),
    ...extra,
  });
  const keys = (jobs: readonly { item: { id: string }; redo?: unknown }[]) =>
    jobs.map((job) => `${job.item.id}${job.redo === undefined ? "" : "+redo"}`);

  it("reruns only the failed rows without redo", () => {
    const results = [result("a", "created"), result("b", "failed"), result("c", "skipped")];
    const next = planRetry(planned, results, false);

    expect(keys(next.jobs)).toEqual(["b"]);
    expect(keys(next.results)).toEqual(["a", "c"]);
    expect(keys(next.planned)).toEqual(["a", "b", "c"]);
  });

  it("redoes the written rows and keeps a failed redo a redo", () => {
    const results = [result("a", "created"), result("b", "failed", { redo: link("b-fr") }), result("c", "skipped")];
    const next = planRetry(planned, results, true);

    expect(keys(next.jobs)).toEqual(["a+redo", "b+redo"]);
    expect(keys(next.results)).toEqual(["c"]);
  });

  it("leaves the retried jobs planned with their redo, so a stop then continue redoes them", () => {
    const next = planRetry(planned, [result("a", "updated"), result("b", "skipped"), result("c", "skipped")], true);

    expect(keys(jobsLeft(next.planned, next.results))).toEqual(["a+redo"]);
  });
});

describe("browser batch run end state", () => {
  const counts = { created: 100, updated: 0, skipped: 0, failed: 0 };
  const run = { started: true, running: false, total: 100, done: 100, counts, error: null };

  it("tells finished, failed, stopped, and errored runs apart", () => {
    expect(batchRunEndState({ ...run, running: true })).toBeNull();
    expect(batchRunEndState(run)).toMatchObject({ tone: "success", title: "Finished", detail: "100 created" });
    expect(batchRunEndState({ ...run, counts: { ...counts, created: 3, failed: 2 } })).toEqual({
      tone: "warning",
      title: "Finished with failures",
      detail: "3 created, 2 failed",
      description: "Retry runs the failed ones again.",
    });
    expect(batchRunEndState({ ...run, total: 10, done: 4 })).toEqual({
      tone: "neutral",
      title: "Stopped",
      detail: "4 of 10 done",
      description: "Translate the 6 left to continue.",
    });
    expect(batchRunEndState({ ...run, done: 40, error: "boom" })).toMatchObject({ tone: "error" });
  });

  it("lists only the non-zero counts", () => {
    expect(batchRunEndState({ ...run, counts: { created: 1, updated: 2, skipped: 0, failed: 0 } })?.detail).toBe("1 created, 2 updated");
    expect(batchRunEndState({ ...run, counts: { created: 0, updated: 0, skipped: 5, failed: 0 } })?.detail).toBe("5 skipped");
  });

  it("reports the remainder exactly at the edges", () => {
    expect(batchRunEndState({ ...run, done: 99 })?.description).toBe("Translate the 1 left to continue.");
    expect(batchRunEndState({ ...run, done: 0 })).toMatchObject({ detail: "0 of 100 done" });
    expect(batchRunEndState({ ...run, total: 0, done: 0, counts: { ...counts, created: 0 } })).toMatchObject({
      title: "Finished",
      detail: null,
    });
    expect(batchRunEndState({ ...run, started: false, done: 0 })).toBeNull();
    expect(batchRunEndState({ ...run, counts: { ...counts, failed: 1 }, error: "boom" })?.description).toContain("0 did not start");
  });

  it("counts outcomes", () => {
    expect(countOutcomes([{ outcome: "created" }, { outcome: "failed" }, { outcome: "created" }])).toEqual({
      created: 2,
      updated: 0,
      skipped: 0,
      failed: 1,
    });
  });
});

describe("selected entries that are already translated", () => {
  it("blocks only when no chosen locale is missing for any selected entry", () => {
    expect(selectedRunBlockReason(1, ["Swedish (sv-SE)"], [])).toBe(
      "Swedish (sv-SE) already has this entry. Turn on Update existing translations to translate it again.",
    );
    expect(selectedRunBlockReason(2, ["Swedish (sv-SE)"], [])).toMatch(/^Every selected entry already has these translations/);
    expect(selectedRunBlockReason(1, ["Swedish (sv-SE)", "German (de)"], [])).toMatch(/^Every selected entry/);
    expect(selectedRunBlockReason(3, ["Swedish (sv-SE)", "German (de)"], ["de"])).toBeNull();
    expect(selectedRunBlockReason(0, ["Swedish (sv-SE)"], [])).toBeNull();
    expect(selectedRunBlockReason(1, [], [])).toBeNull();
  });
});

describe("batch size limit", () => {
  it("refuses runs over the server's limit with its wording", () => {
    expect(batchSizeError(MAX_BATCH_TRANSLATIONS)).toBeNull();
    expect(batchSizeError(MAX_BATCH_TRANSLATIONS + 1)).toContain("select fewer entries or locales");
  });

  it("counts a whole-collection run as every source entry times every locale", () => {
    const stats = { sourceEntries: 10, publishedSourceEntries: 5, untranslated: { fr: 4, de: 0 } };
    expect(collectionRunCounts(stats, ["fr", "de"])).toEqual({ total: 20, toCreate: 4 });
  });
});

describe("batch result rows", () => {
  it("shows outcome badges and the first 100 rows behind Show more", () => {
    const rows: BatchResultRow[] = Array.from({ length: 150 }, (_, index) => ({
      key: String(index),
      title: `Entry ${index}`,
      locale: "fr",
      outcome: "failed",
      message: null,
      translation: null,
    }));
    const html = renderToStaticMarkup(createElement(BatchResultsTable, { collection: "posts", rows, urlContext: undefined }));
    expect(html).toContain("Failed");
    expect(html).toContain("Entry 99<");
    expect(html).not.toContain("Entry 100<");
    expect(html).toContain("Show more");
  });

  it("keeps the failed count on a cancelled job's badge", () => {
    const job: BatchJobView = {
      id: "job-1",
      collection: "posts",
      locales: ["fr"],
      total: 10,
      status: "cancelled",
      createdAt: "2026-03-04T15:30:00.000Z",
      publish: false,
      updateExisting: false,
      listing: false,
      truncated: false,
      entryCount: 10,
      counts: { created: 2, updated: 0, skipped: 0, failed: 3 },
      settings: null,
      retryOf: null,
    };
    const html = renderToStaticMarkup(createElement(BatchJobs, { jobs: [job], collectionLabels: {}, urlContexts: {}, onChange: () => {} }));
    expect(html).toContain("Cancelled, 5 unfinished, 3 failed");
    expect(html).toContain('role="status"');
  });

  it("puts the usage tooltip on a job's progress count only when the job has usage", () => {
    const job: BatchJobView = {
      id: "job-1",
      collection: "posts",
      locales: ["fr"],
      total: 10,
      status: "finished",
      createdAt: "2026-03-04T15:30:00.000Z",
      publish: false,
      updateExisting: false,
      listing: false,
      truncated: false,
      entryCount: 10,
      counts: { created: 10, updated: 0, skipped: 0, failed: 0 },
      settings: null,
      retryOf: null,
    };
    const usage = { calls: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, unreportedCalls: 0 };
    const render = (view: BatchJobView) =>
      renderToStaticMarkup(createElement(BatchJobs, { jobs: [view], collectionLabels: {}, urlContexts: {}, onChange: () => {} }));
    expect(render({ ...job, usage })).toMatch(/<button[^>]*>10\/10<\/button>/);
    expect(render(job)).not.toMatch(/<button[^>]*>10\/10<\/button>/);
  });

  it("names the job a retry came from while it's still listed", () => {
    const original: BatchJobView = {
      id: "job-1",
      collection: "posts",
      locales: ["fr"],
      total: 1,
      status: "finished",
      createdAt: "2026-03-04T15:30:00.000Z",
      publish: false,
      updateExisting: false,
      listing: false,
      truncated: false,
      entryCount: 1,
      counts: { created: 0, updated: 0, skipped: 0, failed: 1 },
      settings: null,
      retryOf: null,
    };
    const retry: BatchJobView = { ...original, id: "job-2", retryOf: "job-1" };
    const render = (jobs: BatchJobView[]) =>
      renderToStaticMarkup(createElement(BatchJobs, { jobs, collectionLabels: {}, urlContexts: {}, onChange: () => {} }));

    expect(render([retry, original])).toContain("Retry of ");
    expect(render([retry])).toContain("<span>Retry</span>");
  });
});

describe("run settings", () => {
  const settings = { model: "@cf/zai-org/glm-4.7-flash", reasoning: null, maxTokens: 16_384, instructions: "" };

  it("summarizes with the short model name and a formatted token limit", () => {
    expect(jobSettingsSummary(settings)).toBe(`glm-4.7-flash, ${(16_384).toLocaleString()} max output tokens`);
    expect(jobSettingsSummary(null)).toBeNull();
  });

  it("names each change for the closed Run settings row", () => {
    const empty = { model: null, reasoning: null, maxTokens: null, instructions: "" };
    expect(jobSettingsChanges(empty)).toEqual([]);
    expect(jobSettingsChanges({ ...empty, instructions: "  " })).toEqual([]);
    expect(jobSettingsChanges({ ...settings, instructions: "Be brief." })).toEqual([
      "Model: glm-4.7-flash",
      `Max tokens: ${(16_384).toLocaleString()}`,
      "Instructions",
    ]);
  });

  it("shows a closed Run settings row with its changes and Reset", () => {
    const render = (value: BatchJobSettings) =>
      renderToStaticMarkup(createElement(JobSettingsSection, { value, disabled: false, onChange: () => {} }));
    const unchanged = render({ model: null, reasoning: null, maxTokens: null, instructions: "" });
    expect(unchanged).toContain('aria-expanded="false"');
    expect(unchanged).not.toContain("Same as translation settings");
    expect(unchanged).not.toContain("Reset");
    const changed = render(settings);
    expect(changed).toContain("Model: glm-4.7-flash");
    expect(changed).toContain("Reset");
    expect(changed).not.toContain("Same as translation settings");
    expect(changed).not.toContain("For this run only");
  });

  it("blocks a token limit outside the allowed range", () => {
    expect(jobSettingsError(settings)).toBeUndefined();
    expect(jobSettingsError({ ...settings, maxTokens: null })).toBeUndefined();
    expect(jobSettingsError({ ...settings, maxTokens: 10 })).toMatch(/whole number/);
  });

  it("sends nothing when no setting differs, and trims instructions", () => {
    const empty = { model: null, reasoning: null, maxTokens: null, instructions: "" };
    expect(jobSettingsPayload(empty)).toBeNull();
    expect(jobSettingsPayload({ ...empty, instructions: "  \n " })).toBeNull();
    expect(jobSettingsPayload({ ...empty, instructions: "  Keep Workers.\n" })).toEqual({ ...empty, instructions: "Keep Workers." });
    expect(jobSettingsPayload({ ...empty, maxTokens: 9000 })).toEqual({ ...empty, maxTokens: 9000 });
  });
});

describe("retry form", () => {
  const render = (props: Partial<Parameters<typeof RetryForm>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(RetryForm, {
        failed: 2,
        written: 0,
        initialSettings: null,
        working: false,
        onRetry: () => {},
        onCancel: () => {},
        ...props,
      }),
    );
  const retryButton = (html: string) => html.match(/<button[^>]*>(?:(?!<\/button>).)*Retry (?:(?!<\/button>).)*<\/button>/s)?.[0] ?? "";
  const isDisabled = /<button[^>]*\sdisabled=""/;
  const text = (html: string) =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  it("explains the settings are for this retry only", () => {
    expect(render()).toContain("Change these for this retry only. Anything left empty uses the translation settings.");
    expect(render()).toContain("Loading translation settings...");
  });

  it("offers the redo switch only when the run wrote translations", () => {
    expect(render()).not.toContain("Also redo");
    expect(render({ written: 3 })).toContain("Also redo the 3 translations this run created or updated");
  });

  it("counts failed, not-run, and (when redo is on) written translations on the button", () => {
    expect(text(retryButton(render({ failed: 2, written: 3 })))).toBe("Retry 2 translations");
    expect(text(retryButton(render({ failed: 1, notRun: 4, written: 3 })))).toBe("Retry 5 translations");
    // Nothing failed or stopped, so redo starts on and the written ones count.
    const redoOnly = retryButton(render({ failed: 0, written: 1 }));
    expect(text(redoOnly)).toBe("Retry 1 translation");
    expect(redoOnly).not.toMatch(isDisabled);
  });

  it("adds the rest of the collection when a cancel stopped the listing", () => {
    expect(text(retryButton(render({ failed: 1, moreToList: true })))).toBe("Retry 1 translation and the rest of the collection");
    const nothingElse = retryButton(render({ failed: 0, written: 0, moreToList: true }));
    expect(nothingElse).not.toMatch(isDisabled);
    expect(retryButton(render({ failed: 0, written: 0 }))).toMatch(isDisabled);
  });

  it("disables Retry while the prefilled token limit is out of range", () => {
    const settings = { model: null, reasoning: null, maxTokens: 10, instructions: "" };
    expect(retryButton(render({ initialSettings: settings }))).toMatch(isDisabled);
    expect(retryButton(render({ initialSettings: { ...settings, maxTokens: 9000 } }))).not.toMatch(isDisabled);
  });
});

describe("batch run page", () => {
  afterEach(() => vi.unstubAllGlobals());
  const text = (html: string) =>
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  it("says the run expired when the tab has no stored plan", () => {
    vi.stubGlobal("window", { location: { search: "" } });
    const html = renderToStaticMarkup(createElement(BatchRunPage));
    expect(html).toContain("already started or has expired");
    expect(html).toContain("Batch translation");
    expect(html).not.toContain("Start translating");
  });

  it("lists the run's settings once as label and value pairs", () => {
    const plan = {
      collection: "pages",
      collectionLabel: "Pages",
      scope: "selected",
      items: [{ id: "a", title: "A", slug: null, locale: "en" }],
      targets: [{ locale: "sv-SE", code: "sv-SE" }],
      options: {
        collection: "pages",
        sourceLocale: "en",
        fields: ["title"],
        updateExisting: false,
        publish: false,
        settings: { model: "@cf/zai-org/glm-4.7-flash", reasoning: null, maxTokens: 16_000, instructions: "Be brief." },
      },
      createdAt: Date.now(),
    };
    vi.stubGlobal("window", {
      location: { search: "?run=r1" },
      localStorage: { getItem: () => JSON.stringify(plan) },
    });
    const html = renderToStaticMarkup(createElement(BatchRunPage));
    const flat = text(html);
    expect(flat).toContain("Entries 1");
    expect(flat).toContain("Translations 1");
    expect(flat).toContain("Existing Skipped");
    expect(flat).toContain("Save as Drafts");
    expect(flat).toContain("Model glm-4.7-flash");
    expect(flat).toContain(`Max tokens ${(16_000).toLocaleString()}`);
    expect(flat).toContain("Instructions Added");
    expect(flat).not.toContain(" × ");
    expect(flat).not.toContain("Settings:");
    expect(flat).toContain("Start translating");
  });
});
