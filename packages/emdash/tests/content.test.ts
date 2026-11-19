import { beforeEach, describe, expect, it, vi } from "vitest";

const emdash = vi.hoisted(() => ({
  getEmDashEntry: vi.fn(),
  getEmDashCollection: vi.fn(),
  getMany: vi.fn(),
}));

vi.mock("emdash", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEmDashEntry: emdash.getEmDashEntry,
  getEmDashCollection: emdash.getEmDashCollection,
  PluginStorageRepository: class {
    getMany = emdash.getMany;
  },
}));
vi.mock("emdash/runtime", () => ({ getDb: async () => ({}) }));

const { getEnrichedCollection, getEnrichedEntry, NOT_AI_TRANSLATED } = await import("../src/content.js");

const record = { collection: "posts", entryId: "01FR", locale: "fr-FR", model: "model-b", aiTranslatedAt: "2026-09-03T00:00:00.000Z" };
const entry = (slug: string, id: string) => ({ id: slug, data: { id, title: slug }, edit: {} });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("enriched content getters", () => {
  it("adds the AI flag by database id and keeps the rest of the result", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: entry("hello", "01FR"), isPreview: false, cacheHint: { tags: ["posts"] } });
    emdash.getMany.mockResolvedValue(new Map([["01FR", record]]));

    const result = await getEnrichedEntry("posts", "hello", { locale: "fr" });

    expect(emdash.getEmDashEntry).toHaveBeenCalledWith("posts", "hello", { locale: "fr" });
    expect(emdash.getMany).toHaveBeenCalledWith(["01FR"]);
    expect(result).toMatchObject({
      isPreview: false,
      cacheHint: { tags: ["posts"] },
      entry: {
        id: "hello",
        data: { title: "hello" },
        polystella: { aiTranslated: true, aiTranslatedAt: "2026-09-03T00:00:00.000Z", aiTranslationModel: "model-b" },
      },
    });
  });

  it("reads a whole page in one storage call and defaults entries without a record", async () => {
    emdash.getEmDashCollection.mockResolvedValue({ entries: [entry("a", "01FR"), entry("b", "01EN")], cacheHint: {} });
    emdash.getMany.mockResolvedValue(new Map([["01FR", record]]));

    const result = await getEnrichedCollection("posts", { locale: "fr" });

    expect(emdash.getMany).toHaveBeenCalledTimes(1);
    expect(result.entries.map((item) => item.polystella.aiTranslated)).toEqual([true, false]);
  });

  it("never breaks the page when storage fails", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: entry("hello", "01FR"), isPreview: false, cacheHint: {} });
    emdash.getMany.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await getEnrichedEntry("posts", "hello");

    expect(result.entry?.polystella).toEqual(NOT_AI_TRANSLATED);
  });

  it("returns a missing entry unchanged without reading storage", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: null, isPreview: false, cacheHint: {} });

    expect((await getEnrichedEntry("posts", "nope")).entry).toBeNull();
    expect(emdash.getMany).not.toHaveBeenCalled();
  });
});
