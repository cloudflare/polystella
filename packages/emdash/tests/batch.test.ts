import { ApiResponseError } from "@emdash-cms/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  createContent: vi.fn(),
  fetchContent: vi.fn(),
  fetchContentList: vi.fn(),
  fetchTranslations: vi.fn(),
  publishContent: vi.fn(),
  updateContent: vi.fn(),
}));

vi.mock("@emdash-cms/admin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...admin }));

const { translateIntoDraft } = await import("../src/admin/content-translation.js");
const {
  batchRunUrl,
  clearBatchRun,
  collectionTranslationStats,
  findExistingTranslation,
  planBatchJobs,
  publicContentUrl,
  readBatchRun,
  runBatchJob,
  runBatchJobs,
  saveBatchRun,
  untranslatedLocales,
} = await import("../src/admin/plugin-page/tabs/BatchTab/helpers.js");

const job = { item: { id: "post-1", title: "Hello", slug: "hello" }, target: { locale: "fr", code: "fr-FR" } };
const options = { collection: "posts", sourceLocale: "en", fields: ["title"], updateExisting: false, publish: false };

beforeEach(() => {
  vi.resetAllMocks();
  admin.apiFetch.mockImplementation(async () => Response.json({ data: { patch: { title: "Bonjour" }, batchCount: 1 } }));
});

describe("batch translation", () => {
  it("plans one job per entry and locale", () => {
    const items = [
      { id: "a", title: "A", slug: "a" },
      { id: "b", title: "B", slug: null },
    ];
    const targets = [
      { locale: "fr", code: "fr-FR" },
      { locale: "de", code: "de-DE" },
    ];
    expect(planBatchJobs(items, targets).map(({ item, target }) => `${item.id}:${target.locale}`)).toEqual([
      "a:fr",
      "a:de",
      "b:fr",
      "b:de",
    ]);
  });

  it("counts source entries and untranslated ones per locale across pages, by translation group", async () => {
    const row = (id: string, locale: string, translationGroup: string | null, status = "draft") => ({
      id,
      locale,
      translationGroup,
      status,
    });
    const pages: Record<string, { items: ReturnType<typeof row>[]; nextCursor?: string }[]> = {
      en: [
        { items: [row("a", "en", "a", "published"), row("b", "en", null)], nextCursor: "2" },
        { items: [row("c", "en", "c"), row("x", "fr", "c")] },
      ],
      // The server filters by exact locale, so the older "fr-FR" translation only comes back from its own query.
      fr: [{ items: [row("c-fr", "fr", "c")] }],
      "fr-FR": [{ items: [row("a-fr", "fr-FR", "a")] }],
    };
    admin.fetchContentList.mockImplementation(
      async (_collection: string, { locale, cursor }: { locale: string; cursor?: string }) =>
        (pages[locale] ?? [])[cursor === undefined ? 0 : Number(cursor) - 1] ?? { items: [] },
    );
    const targets = [
      { locale: "fr", code: "fr-FR" },
      { locale: "de", code: "de-DE" },
    ];
    await expect(collectionTranslationStats("posts", "en", targets)).resolves.toEqual({
      sourceEntries: 3,
      publishedSourceEntries: 1,
      untranslated: { fr: 1, de: 3 },
    });
  });

  it("counts every source entry as untranslated for a locale with no rows, and skips target lists with no targets", async () => {
    const rows = [
      { id: "a", locale: "en", translationGroup: "a", status: "published" },
      { id: "b", locale: "en", translationGroup: null, status: "draft" },
    ];
    admin.fetchContentList.mockResolvedValue({ items: rows });
    await expect(collectionTranslationStats("posts", "en", [])).resolves.toEqual({
      sourceEntries: 2,
      publishedSourceEntries: 1,
      untranslated: {},
    });
    expect(admin.fetchContentList).toHaveBeenCalledTimes(1);
  });

  it("matches a translation to a source entry with no translation group by id, and ignores other locales", async () => {
    const source = [
      { id: "a", locale: "en", translationGroup: null, status: "draft" },
      { id: "b", locale: "en", translationGroup: null, status: "draft" },
    ];
    const frRows = [
      { id: "a-fr", locale: "fr-FR", translationGroup: "a", status: "draft" },
      { id: "b-de", locale: "de", translationGroup: "b", status: "draft" },
    ];
    admin.fetchContentList.mockImplementation(async (_collection: string, { locale }: { locale: string }) => ({
      items: locale === "en" ? source : frRows,
    }));
    const stats = await collectionTranslationStats("posts", "en", [{ locale: "fr", code: "fr-FR" }]);
    expect(stats.untranslated).toEqual({ fr: 1 });
  });

  it("stops paging once the summary's signal is aborted", async () => {
    const controller = new AbortController();
    admin.fetchContentList.mockImplementation(async () => {
      controller.abort();
      return { items: [{ id: "a", locale: "en", translationGroup: null, status: "draft" }], nextCursor: "next" };
    });
    await expect(collectionTranslationStats("posts", "en", [], controller.signal)).rejects.toThrow();
    expect(admin.fetchContentList).toHaveBeenCalledTimes(1);
  });

  it("matches existing translations by locale path or catalog code", () => {
    const target = { locale: "fr", code: "fr-FR" };
    expect(findExistingTranslation([{ id: "1", locale: "FR-fr" }], target)?.id).toBe("1");
    expect(findExistingTranslation([{ id: "2", locale: "fr" }], target)?.id).toBe("2");
    expect(findExistingTranslation([{ id: "3", locale: "de" }], target)).toBeUndefined();
  });

  it("lists locales missing from at least one entry, in target order", async () => {
    const existing: Record<string, string[]> = { a: ["fr-FR", "de"], b: ["fr"] };
    admin.fetchTranslations.mockImplementation(async (_collection: string, id: string) => ({
      translations: (existing[id] ?? []).map((locale) => ({ id: `${id}-${locale}`, locale })),
    }));
    const targets = [
      { locale: "fr", code: "fr-FR" },
      { locale: "de", code: "de-DE" },
      { locale: "es", code: "es-ES" },
    ];
    await expect(untranslatedLocales("posts", ["a", "b"], targets, 2)).resolves.toEqual(["de", "es"]);
  });

  it("builds public URLs the way EmDash's admin does", () => {
    const translation = { id: "01FR", locale: "fr", slug: "hello", published: true };
    const i18n = { defaultLocale: "en" };
    expect(publicContentUrl(translation, { urlPattern: "/{slug}/", i18n })).toBe("/fr/hello/");
    expect(publicContentUrl(translation, { urlPattern: undefined, i18n })).toBeNull();
    expect(publicContentUrl(translation, { urlPattern: "", i18n })).toBeNull();
    expect(publicContentUrl({ ...translation, locale: "en" }, { urlPattern: "/blog/{slug}", i18n })).toBe("/blog/hello");
    expect(publicContentUrl(translation, { urlPattern: "/{year}/{slug}", i18n })).toBeNull();
    expect(publicContentUrl({ ...translation, slug: null }, { urlPattern: "/{slug}", i18n })).toBeNull();
  });

  it("hands a run to the new tab through storage and builds its address", () => {
    const rows = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return rows.size;
      },
      key: (index) => [...rows.keys()][index] ?? null,
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => void rows.set(key, value),
      removeItem: (key) => void rows.delete(key),
      clear: () => rows.clear(),
    };
    const plan = {
      collection: "posts",
      scope: "selected" as const,
      items: [job.item],
      targets: [job.target],
      options,
      localeTags: { "es-la": "es-419" },
      createdAt: 1_000,
    };
    rows.set("polystella:batch-run:old", JSON.stringify({ ...plan, createdAt: -100_000_000 }));
    rows.set("polystella:batch-run:corrupt", "{");
    rows.set("unrelated", "keep");

    const id = saveBatchRun(plan, storage);

    expect([...rows.keys()].sort()).toEqual([`polystella:batch-run:${id}`, "unrelated"]);
    expect(readBatchRun(id, storage)).toEqual(plan);
    clearBatchRun(id, storage);
    expect(readBatchRun(id, storage)).toBeNull();
    expect(batchRunUrl("/_emdash/admin/plugins/polystella/", "r1")).toBe("/_emdash/admin/plugins/polystella/batch-run?run=r1");
    expect(batchRunUrl("/_emdash/admin/plugins/polystella", "r1")).toBe("/_emdash/admin/plugins/polystella/batch-run?run=r1");
  });

  it("caps concurrency and stops picking jobs once asked", async () => {
    let active = 0;
    let peak = 0;
    const ran: number[] = [];
    await runBatchJobs(
      [1, 2, 3, 4, 5, 6],
      2,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        ran.push(value);
        active -= 1;
      },
      () => ran.length >= 3,
    );
    expect(peak).toBe(2);
    expect(ran.length).toBeLessThan(6);
  });

  it("creates a draft for a missing locale", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [{ id: "post-1", locale: "en" }] });
    admin.fetchContent.mockResolvedValue({ id: "post-1", slug: "hello", data: { title: "Hello", body: [] } });
    admin.createContent.mockResolvedValue({ id: "post-1-fr", locale: "fr" });

    expect(await runBatchJob(job, options)).toMatchObject({
      outcome: "created",
      message: null,
      translation: { id: "post-1-fr", locale: "fr" },
    });
    expect(admin.publishContent).not.toHaveBeenCalled();
    expect(admin.createContent).toHaveBeenCalledWith("posts", {
      data: { title: "Bonjour", body: [] },
      slug: "hello",
      locale: "fr",
      translationOf: "post-1",
    });
  });

  it("publishes when asked, keeping the draft and noting a failed publish", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [] });
    admin.fetchContent.mockResolvedValue({ id: "post-1", slug: "hello", data: { title: "Hello" } });
    admin.createContent.mockResolvedValue({ id: "post-1-fr", locale: "fr" });
    admin.publishContent.mockResolvedValueOnce({ id: "post-1-fr" });

    expect(await runBatchJob(job, { ...options, publish: true })).toMatchObject({ outcome: "created", message: "Published." });
    expect(admin.publishContent).toHaveBeenCalledWith("posts", "post-1-fr", { locale: "fr" });

    admin.publishContent.mockRejectedValueOnce(new Error("slug taken"));
    expect(await runBatchJob(job, { ...options, publish: true })).toMatchObject({
      outcome: "created",
      message: "Saved as a draft; publishing failed: slug taken",
    });
  });

  it("keeps a row created when only the AI-translated flag fails to save, and says so", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [] });
    admin.fetchContent.mockResolvedValue({ id: "post-1", slug: "hello", data: { title: "Hello" } });
    admin.createContent.mockResolvedValue({ id: "post-1-fr", locale: "fr" });
    admin.apiFetch.mockImplementation(async (url: string) =>
      url.includes("ai-translation")
        ? Response.json({ error: { message: "storage down" } }, { status: 500 })
        : Response.json({ data: { patch: { title: "Bonjour" }, batchCount: 1 } }),
    );
    admin.publishContent.mockResolvedValueOnce({ id: "post-1-fr" });

    const result = await runBatchJob(job, { ...options, publish: true });

    expect(result.outcome).toBe("created");
    expect(result.message).toMatch(/^Saved, but PolyStella could not mark it as AI-translated \(.+\)\. Published\.$/);
  });

  it("skips existing translations unless updates are enabled", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [{ id: "post-1-fr", locale: "fr" }] });

    expect(await runBatchJob(job, options)).toMatchObject({ outcome: "skipped", translation: { id: "post-1-fr", locale: "fr" } });
    expect(admin.apiFetch).not.toHaveBeenCalled();
    expect(admin.updateContent).not.toHaveBeenCalled();
  });

  it("updates existing translations with the revision it read", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [{ id: "post-1-fr", locale: "fr" }] });
    admin.fetchContent.mockResolvedValue({ id: "post-1-fr", _rev: "rev-7", data: {} });
    admin.updateContent.mockResolvedValue({ id: "post-1-fr" });

    expect(await runBatchJob(job, { ...options, updateExisting: true })).toMatchObject({ outcome: "updated" });
    expect(admin.updateContent).toHaveBeenCalledWith("posts", "post-1-fr", { data: { title: "Bonjour" }, _rev: "rev-7" }, { locale: "fr" });
  });

  it("reports an entry edited during the run as skipped, not failed", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [{ id: "post-1-fr", locale: "fr" }] });
    admin.fetchContent.mockResolvedValue({ id: "post-1-fr", _rev: "rev-7", data: {} });
    admin.updateContent.mockRejectedValue(new ApiResponseError(409, "CONFLICT", "Revision mismatch"));

    expect(await runBatchJob(job, { ...options, updateExisting: true })).toMatchObject({ outcome: "skipped" });
  });

  it("turns translation errors into failed rows", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [] });
    admin.fetchContent.mockResolvedValue({ id: "post-1", slug: "hello", data: {} });
    admin.apiFetch.mockResolvedValue(Response.json({ error: { code: "INTERNAL_ERROR", message: "provider down" } }, { status: 500 }));

    const result = await runBatchJob(job, options);
    expect(result.outcome).toBe("failed");
    expect(admin.createContent).not.toHaveBeenCalled();
  });
});

describe("translating into the open editor", () => {
  const input = { collection: "posts", entryId: "post-1-fr", locale: "fr", fields: ["title", "seo.title", "seo.description"] };
  const definitions = [
    { slug: "seo.title", label: "SEO title", type: "string", required: false, translatable: true, validation: { maxLength: 10 } },
    { slug: "seo.description", label: "SEO description", type: "string", required: false, translatable: true },
  ];
  const translated = { "seo.title": "Short one", "seo.description": "A long description", title: "Bonjour" };
  const before = { title: "Hello", other: "a" };

  // The first `get()` is the snapshot taken before translating; later ones are taken just before the patch.
  function editorDraft(options: { readOnly?: boolean; outcome?: unknown; later?: Record<string, unknown> } = {}) {
    const patch = vi.fn((_operations: unknown, _options: unknown) => options.outcome ?? { ok: true });
    const get = vi
      .fn()
      .mockReturnValueOnce({ revision: "rev-1", readOnly: options.readOnly ?? false, fields: before, fieldDefinitions: definitions })
      .mockReturnValue({ revision: "rev-2", readOnly: false, fields: options.later ?? before, fieldDefinitions: definitions });
    return { draft: { get, patch } as unknown as Parameters<typeof translateIntoDraft>[0]["editorDraft"], patch };
  }
  const requests = () =>
    (admin.apiFetch.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => ({
      url,
      body: JSON.parse(String(init.body ?? "null")),
    }));
  const pendingRequests = () => requests().filter(({ url }) => url.includes("ai-translation/pending"));

  // `added` mimics the server: the fields this request newly put on the pending record.
  function respond(patch: Record<string, unknown> = translated, pendingStatus = 200, added?: string[]) {
    admin.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("translate-content")) return Response.json({ data: { patch } });
      if (pendingStatus !== 200) return Response.json({ error: { message: "storage down" } }, { status: pendingStatus });
      const body = JSON.parse(String(init?.body ?? "{}")) as { fields: string[]; cancel?: boolean };
      return Response.json({ data: { recorded: true, added: body.cancel === true ? [] : (added ?? body.fields) } });
    });
  }

  beforeEach(() => respond());

  it("sends nothing from a read-only editor", async () => {
    const { draft, patch } = editorDraft({ readOnly: true });
    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toEqual({
      status: "refused",
      code: "EDITOR_DRAFT_READ_ONLY",
    });
    expect(admin.apiFetch).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("records the non-SEO fields as pending before patching with the latest revision", async () => {
    const { draft, patch } = editorDraft();

    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toMatchObject({
      status: "applied",
      tooLong: [],
      flagWarning: null,
    });

    expect(pendingRequests().map(({ body }) => body)).toEqual([{ collection: "posts", entryId: "post-1-fr", fields: ["title"] }]);
    expect(patch).toHaveBeenCalledWith(
      [
        { op: "set", field: "seo.title", value: "Short one" },
        { op: "set", field: "seo.description", value: "A long description" },
        { op: "set", field: "title", value: "Bonjour" },
      ],
      { expectedRevision: "rev-2" },
    );
    const pendingOrder = admin.apiFetch.mock.invocationCallOrder[1] ?? 0;
    expect(pendingOrder).toBeLessThan(patch.mock.invocationCallOrder[0] ?? 0);
  });

  it("leaves out a too-long SEO value and lists it, and records no pending field for SEO-only patches", async () => {
    respond({ ...translated, "seo.title": "Far too long a title" });
    const { draft, patch } = editorDraft();
    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toMatchObject({
      status: "applied",
      tooLong: ["seo.title"],
    });
    expect(patch.mock.calls[0]?.[0]).toEqual([
      { op: "set", field: "seo.description", value: "A long description" },
      { op: "set", field: "title", value: "Bonjour" },
    ]);

    admin.apiFetch.mockClear();
    respond({ "seo.description": "A long description" });
    await translateIntoDraft({ ...input, editorDraft: editorDraft().draft });
    expect(pendingRequests()).toEqual([]);
  });

  it("fails when every translation is too long, before recording anything", async () => {
    respond({ "seo.title": "Far too long a title" });
    const { draft, patch } = editorDraft();
    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toMatchObject({ status: "failed" });
    expect(pendingRequests()).toEqual([]);
    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses without patching, and cancels the pending record, when a translated field changed meanwhile", async () => {
    const { draft, patch } = editorDraft({ later: { ...before, title: "Typed by the editor" } });

    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toEqual({ status: "refused", code: "EDITOR_DRAFT_STALE" });

    expect(patch).not.toHaveBeenCalled();
    expect(pendingRequests().map(({ body }) => body)).toEqual([
      { collection: "posts", entryId: "post-1-fr", fields: ["title"] },
      { collection: "posts", entryId: "post-1-fr", fields: ["title"], cancel: true },
    ]);
  });

  it("still patches when only another field changed", async () => {
    const { draft, patch } = editorDraft({ later: { ...before, other: "b" } });
    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toMatchObject({ status: "applied" });
    expect(patch).toHaveBeenCalledOnce();
  });

  it("cancels the pending record when the host refuses the patch", async () => {
    const { draft } = editorDraft({ outcome: { ok: false, code: "EDITOR_DRAFT_INVALID", message: "invalid" } });
    await expect(translateIntoDraft({ ...input, editorDraft: draft })).resolves.toEqual({
      status: "refused",
      code: "EDITOR_DRAFT_INVALID",
    });
    expect(pendingRequests().at(-1)?.body).toMatchObject({ cancel: true, fields: ["title"] });
  });

  it("cancels only the fields this call added, so an earlier pending translation survives", async () => {
    const stale = { ok: false, code: "EDITOR_DRAFT_STALE", message: "stale" };
    respond(translated, 200, []);
    await translateIntoDraft({ ...input, editorDraft: editorDraft({ outcome: stale }).draft });
    expect(pendingRequests()).toHaveLength(1);

    respond(translated, 200, ["title"]);
    admin.apiFetch.mockClear();
    await translateIntoDraft({ ...input, editorDraft: editorDraft({ outcome: stale }).draft });
    expect(pendingRequests().at(-1)?.body).toMatchObject({ cancel: true, fields: ["title"] });
  });

  it("warns, and has nothing to cancel, when the pending record could not be stored", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    respond(translated, 500);

    const applied = await translateIntoDraft({ ...input, editorDraft: editorDraft().draft });
    expect(applied).toMatchObject({ status: "applied", flagWarning: expect.stringContaining("could not mark it as AI-translated") });

    admin.apiFetch.mockClear();
    const { draft } = editorDraft({ outcome: { ok: false, code: "EDITOR_DRAFT_STALE", message: "stale" } });
    await translateIntoDraft({ ...input, editorDraft: draft });
    expect(pendingRequests().filter(({ body }) => (body as { cancel?: boolean }).cancel === true)).toEqual([]);
    consoleError.mockRestore();
  });
});
