import { ApiResponseError } from "@emdash-cms/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  createContent: vi.fn(),
  fetchContent: vi.fn(),
  fetchTranslations: vi.fn(),
  updateContent: vi.fn(),
}));

vi.mock("@emdash-cms/admin", async (importOriginal) => ({ ...(await importOriginal<object>()), ...admin }));

const { findExistingTranslation, planBatchJobs, runBatchJob, runBatchJobs } =
  await import("../src/admin/plugin-page/tabs/BatchTab/helpers.js");

const job = { item: { id: "post-1", title: "Hello", slug: "hello" }, target: { locale: "fr", code: "fr-FR" } };
const options = { collection: "posts", sourceLocale: "en", fields: ["title"], updateExisting: false };

beforeEach(() => {
  vi.resetAllMocks();
  admin.apiFetch.mockResolvedValue(Response.json({ data: { patch: { title: "Bonjour" }, batchCount: 1 } }));
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
    admin.createContent.mockResolvedValue({ id: "post-1-fr" });

    expect(await runBatchJob(job, options)).toMatchObject({ outcome: "created", message: null });
    expect(admin.createContent).toHaveBeenCalledWith("posts", {
      data: { title: "Bonjour", body: [] },
      slug: "hello",
      locale: "fr",
      translationOf: "post-1",
    });
  });

  it("skips existing translations unless updates are enabled", async () => {
    admin.fetchTranslations.mockResolvedValue({ translationGroup: "g", translations: [{ id: "post-1-fr", locale: "fr" }] });

    expect(await runBatchJob(job, options)).toMatchObject({ outcome: "skipped" });
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
