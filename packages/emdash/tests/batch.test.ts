import { ApiResponseError } from "@emdash-cms/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  createContent: vi.fn(),
  fetchContent: vi.fn(),
  fetchTranslations: vi.fn(),
  publishContent: vi.fn(),
  updateContent: vi.fn(),
}));

vi.mock("@emdash-cms/admin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...admin }));

const {
  batchRunUrl,
  clearBatchRun,
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
    const plan = { collection: "posts", scope: "selected" as const, items: [job.item], targets: [job.target], options, createdAt: 1_000 };
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
