import { describe, expect, it, vi } from "vitest";
import type { StorageCollection } from "emdash";

const objectCache = vi.hoisted(() => ({ invalidateObjectCache: vi.fn() }));
vi.mock("emdash", async (importOriginal) => ({ ...(await importOriginal<object>()), ...objectCache }));

const { translatedFieldsHash } = await import("../src/ai-translations.js");
const { clearEditedAiTranslation } = await import("../src/server/ai-translation-hooks.js");

function flagStorage(value: unknown, revision = "r1") {
  const deleted: string[] = [];
  const storage = {
    getVersioned: async () => (value === null ? null : { value, revision }),
    compareAndDelete: async (id: string, expected: string) => {
      const applied = expected === revision;
      if (applied) deleted.push(id);
      return { applied };
    },
  } as Pick<StorageCollection, "getVersioned" | "compareAndDelete"> as StorageCollection;
  return { storage, deleted };
}

async function record(data: Record<string, unknown>) {
  return {
    collection: "posts",
    entryId: "e1",
    fields: ["title", "body"],
    contentHash: await translatedFieldsHash(data, ["title", "body"]),
  };
}

describe("AI-translated flag auto-clear", () => {
  it("keeps the flag while the translated fields are unchanged, whatever their key order", async () => {
    const { storage, deleted } = flagStorage(await record({ title: "Bonjour", body: [{ a: 1, b: 2 }] }));
    await clearEditedAiTranslation({ id: "e1", data: { body: [{ b: 2, a: 1 }], title: "Bonjour", other: "edited" } }, storage);
    expect(deleted).toEqual([]);
  });

  it("clears the flag once a translated field changes", async () => {
    objectCache.invalidateObjectCache.mockClear();
    const { storage, deleted } = flagStorage(await record({ title: "Bonjour", body: [] }));
    await clearEditedAiTranslation({ id: "e1", data: { title: "Salut", body: [] } }, storage);
    expect(deleted).toEqual(["e1"]);
    expect(objectCache.invalidateObjectCache).toHaveBeenCalledWith("plugin:polystella:ai");
  });

  it("leaves records without a fingerprint, and entries without one, alone", async () => {
    const legacy = flagStorage({ collection: "posts", entryId: "e1", model: "m", aiTranslatedAt: "t" });
    await clearEditedAiTranslation({ id: "e1", data: { title: "Salut" } }, legacy.storage);
    expect(legacy.deleted).toEqual([]);
    const none = flagStorage(null);
    await expect(clearEditedAiTranslation({ id: "e1", data: {} }, none.storage)).resolves.toBeUndefined();
    await expect(clearEditedAiTranslation({ data: {} }, none.storage)).resolves.toBeUndefined();
  });
});
