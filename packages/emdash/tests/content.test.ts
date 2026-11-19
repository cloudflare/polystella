import { beforeEach, describe, expect, it, vi } from "vitest";

const emdash = vi.hoisted(() => ({
  getEmDashEntry: vi.fn(),
  getEmDashCollection: vi.fn(),
  getMany: vi.fn(),
  getRequestContext: vi.fn(),
  cachedQuery: vi.fn(),
}));

vi.mock("emdash", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEmDashEntry: emdash.getEmDashEntry,
  getEmDashCollection: emdash.getEmDashCollection,
  getRequestContext: emdash.getRequestContext,
  cachedQuery: emdash.cachedQuery,
  PluginStorageRepository: class {
    getMany = emdash.getMany;
  },
}));
vi.mock("emdash/runtime", () => ({ getDb: async () => ({}) }));

const { getEnrichedCollection, getEnrichedEntry, NOT_AI_TRANSLATED } = await import("../src/content.js");

const record = { collection: "posts", entryId: "01FR", locale: "fr-FR", model: "model-b", aiTranslatedAt: "2026-09-03T00:00:00.000Z" };
const entry = (slug: string, id: string) => ({ id: slug, data: { id, title: slug }, edit: {} });

// Mirrors EmDash's object cache: stores a loaded value, never a thrown load.
const objectCache = new Map<string, unknown>();
async function fakeCachedQuery(options: { namespace: string; key: string; load: () => Promise<unknown> }): Promise<unknown> {
  const fullKey = `${options.namespace}:${options.key}`;
  if (objectCache.has(fullKey)) return objectCache.get(fullKey);
  const value = await options.load();
  objectCache.set(fullKey, value);
  return value;
}

beforeEach(() => {
  vi.resetAllMocks();
  objectCache.clear();
  emdash.cachedQuery.mockImplementation(fakeCachedQuery);
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

  it("serves repeat single-entry reads from the object cache, keyed by entry id", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: entry("hello", "01FR"), isPreview: false, cacheHint: {} });
    emdash.getMany.mockResolvedValue(new Map([["01FR", record]]));

    await getEnrichedEntry("posts", "hello");
    const second = await getEnrichedEntry("posts", "hello");

    expect(emdash.getMany).toHaveBeenCalledTimes(1);
    expect(second.entry?.polystella.aiTranslated).toBe(true);
    expect([...objectCache.keys()]).toEqual(["plugin:polystella:ai:entry:01FR"]);
  });

  it("caches a page under a short hashed key that ignores entry order", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `01ENTRY${String(index).padStart(19, "0")}`);
    emdash.getMany.mockResolvedValue(new Map());
    emdash.getEmDashCollection.mockResolvedValueOnce({ entries: ids.map((id) => entry(id, id)), cacheHint: {} });
    emdash.getEmDashCollection.mockResolvedValueOnce({ entries: [...ids].reverse().map((id) => entry(id, id)), cacheHint: {} });

    await getEnrichedCollection("posts");
    await getEnrichedCollection("posts");

    expect(emdash.getMany).toHaveBeenCalledTimes(1);
    const [key] = [...objectCache.keys()];
    expect(key).toMatch(/^plugin:polystella:ai:list:[0-9a-f]{16}$/);
  });

  it("reads once per request when the object cache is off", async () => {
    emdash.cachedQuery.mockImplementation(async (options: { load: () => Promise<unknown> }) => options.load());
    emdash.getEmDashEntry.mockResolvedValue({ entry: entry("hello", "01FR"), isPreview: false, cacheHint: {} });
    emdash.getMany.mockResolvedValue(new Map([["01FR", record]]));
    const request = {};
    emdash.getRequestContext.mockReturnValue(request);

    await getEnrichedEntry("posts", "hello");
    await getEnrichedEntry("posts", "hello");
    expect(emdash.getMany).toHaveBeenCalledTimes(1);

    emdash.getRequestContext.mockReturnValue({});
    await getEnrichedEntry("posts", "hello");
    expect(emdash.getMany).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: entry("hello", "01FR"), isPreview: false, cacheHint: {} });
    emdash.getMany.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(new Map([["01FR", record]]));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect((await getEnrichedEntry("posts", "hello")).entry?.polystella.aiTranslated).toBe(false);
    expect((await getEnrichedEntry("posts", "hello")).entry?.polystella.aiTranslated).toBe(true);
  });

  it("returns a missing entry unchanged without reading storage", async () => {
    emdash.getEmDashEntry.mockResolvedValue({ entry: null, isPreview: false, cacheHint: {} });

    expect((await getEnrichedEntry("posts", "nope")).entry).toBeNull();
    expect(emdash.getMany).not.toHaveBeenCalled();
  });
});
