import { describe, expect, it, vi } from "vitest";
import type { SettingsAccess, StorageCollection } from "emdash";

const objectCache = vi.hoisted(() => ({ invalidateObjectCache: vi.fn() }));
vi.mock("emdash", async (importOriginal) => ({ ...(await importOriginal<object>()), ...objectCache }));

const { hashFields } = await import("../src/ai-translations.js");
const { clearEditedAiTranslation, confirmPendingAiTranslation } = await import("../src/server/ai-translation-hooks.js");

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

function settings(clearAiFlagOnEdit: boolean): SettingsAccess {
  return { get: async () => ({ clearAiFlagOnEdit }) } as Pick<SettingsAccess, "get"> as SettingsAccess;
}

async function record(data: Record<string, unknown>) {
  return { collection: "posts", entryId: "e1", fieldHashes: await hashFields(data, ["title", "body"]) };
}

describe("AI-translated flag auto-clear", () => {
  it("keeps the flag while AI-written fields are unchanged, whatever their key order", async () => {
    const { storage, deleted } = flagStorage(await record({ title: "Bonjour", body: [{ a: 1, b: 2 }] }));
    await clearEditedAiTranslation(
      { id: "e1", data: { body: [{ b: 2, a: 1 }], title: "Bonjour", other: "edited" } },
      storage,
      settings(true),
    );
    expect(deleted).toEqual([]);
  });

  it("removes the flag after an edit only when the administrator opted in", async () => {
    objectCache.invalidateObjectCache.mockClear();
    const edited = { id: "e1", data: { title: "Salut", body: [] } };
    const kept = flagStorage(await record({ title: "Bonjour", body: [] }));
    await clearEditedAiTranslation(edited, kept.storage, settings(false));
    expect(kept.deleted).toEqual([]);

    const cleared = flagStorage(await record({ title: "Bonjour", body: [] }));
    await clearEditedAiTranslation(edited, cleared.storage, settings(true));
    expect(cleared.deleted).toEqual(["e1"]);
    expect(objectCache.invalidateObjectCache).toHaveBeenCalledWith("plugin:polystella:ai");
  });

  it("leaves records without a fingerprint, and entries without one, alone", async () => {
    const legacy = flagStorage({ collection: "posts", entryId: "e1", model: "m", aiTranslatedAt: "t" });
    await clearEditedAiTranslation({ id: "e1", data: { title: "Salut" } }, legacy.storage, settings(true));
    expect(legacy.deleted).toEqual([]);
    const none = flagStorage(null);
    await expect(clearEditedAiTranslation({ id: "e1", data: {} }, none.storage, settings(true))).resolves.toBeUndefined();
    await expect(clearEditedAiTranslation({ data: {} }, none.storage, settings(true))).resolves.toBeUndefined();
  });
});

describe("pending AI translation confirmation", () => {
  const now = new Date("2026-09-03T00:30:00.000Z");
  const saved = { title: "Bonjour", body: "Corps", note: "Changed" };

  async function pendingRecord(overrides: Record<string, unknown> = {}) {
    return {
      collection: "posts",
      entryId: "e1",
      locale: "fr-FR",
      model: "m",
      aiTranslatedAt: "2026-09-03T00:00:00.000Z",
      fields: ["title", "body"],
      baseline: await hashFields({ title: "Hello", body: "Body" }, ["title", "body"]),
      ...overrides,
    };
  }

  // In-memory pending row with the revision checks the hook relies on.
  function pendingStorage(initial: unknown, lostRace = false) {
    let row: { value: unknown; revision: string } | null = initial === null ? null : { value: initial, revision: "r1" };
    const storage = {
      getVersioned: async () => row,
      compareAndDelete: async () => {
        if (lostRace) return { applied: false };
        row = null;
        return { applied: true };
      },
      compareAndSet: async (_id: string, _revision: string, value: unknown) => {
        if (lostRace) return { applied: false };
        row = { value, revision: "r2" };
        return { applied: true, revision: "r2" };
      },
    } as Pick<StorageCollection, "getVersioned" | "compareAndDelete" | "compareAndSet"> as StorageCollection;
    return { storage, row: () => row?.value ?? null };
  }

  function flags(previous: unknown = null) {
    const puts: unknown[] = [];
    const storage = { get: async () => previous, put: async (_id: string, value: unknown) => void puts.push(value) } as Pick<
      StorageCollection,
      "get" | "put"
    > as StorageCollection;
    return { storage, puts };
  }

  it("confirms a changed field with its saved hash, keeping every earlier hash", async () => {
    objectCache.invalidateObjectCache.mockClear();
    const pending = pendingStorage(await pendingRecord({ fields: ["title"] }));
    const earlier = { fieldHashes: await hashFields({ body: "Corps", note: "Edited" }, ["body", "note"]) };
    const { storage, puts } = flags(earlier);

    await confirmPendingAiTranslation({ id: "e1", data: saved }, pending.storage, storage, now);

    expect(puts).toEqual([
      {
        collection: "posts",
        entryId: "e1",
        locale: "fr-FR",
        model: "m",
        aiTranslatedAt: "2026-09-03T00:00:00.000Z",
        // Earlier hashes stay even for `note`, which was edited since: the edit check still has to see it.
        fieldHashes: { ...earlier.fieldHashes, ...(await hashFields(saved, ["title"])) },
      },
    ]);
    expect(pending.row()).toBeNull();
    expect(objectCache.invalidateObjectCache).toHaveBeenCalledWith("plugin:polystella:ai");
  });

  it("keeps fields the save didn't change pending, and ignores fields missing from the save", async () => {
    const pending = pendingStorage(await pendingRecord());
    const { storage, puts } = flags();

    // `body` is absent (a partial save); `title` changed.
    await confirmPendingAiTranslation({ id: "e1", data: { title: "Bonjour" } }, pending.storage, storage, now);

    expect(puts).toEqual([expect.objectContaining({ fieldHashes: await hashFields({ title: "Bonjour" }, ["title"]) })]);
    expect(pending.row()).toMatchObject({ fields: ["body"] });
  });

  it("does not confirm a save that leaves the pending fields at their baseline", async () => {
    const pending = pendingStorage(await pendingRecord());
    const { storage, puts } = flags();

    await confirmPendingAiTranslation(
      { id: "e1", data: { title: "Hello", body: "Body", seo: "edited elsewhere" } },
      pending.storage,
      storage,
      now,
    );

    expect(puts).toEqual([]);
    expect(pending.row()).toMatchObject({ fields: ["title", "body"] });
  });

  it("deletes an expired or malformed pending record without flagging the entry", async () => {
    const { storage, puts } = flags();
    const expired = pendingStorage(await pendingRecord());
    await confirmPendingAiTranslation({ id: "e1", data: saved }, expired.storage, storage, new Date("2026-09-03T01:00:01.000Z"));
    const malformed = pendingStorage({ collection: "posts", fields: "title" });
    await confirmPendingAiTranslation({ id: "e1", data: saved }, malformed.storage, storage, now);

    expect(expired.row()).toBeNull();
    expect(malformed.row()).toBeNull();
    expect(puts).toEqual([]);
  });

  it("lets the edit check remove the flag when the same save confirms one field and edits another flagged one", async () => {
    const pending = pendingStorage(await pendingRecord({ fields: ["title"] }));
    let flag: unknown = { collection: "posts", entryId: "e1", fieldHashes: await hashFields({ body: "Old body" }, ["body"]) };
    const store = {
      get: async () => flag,
      put: async (_id: string, value: unknown) => void (flag = value),
      getVersioned: async () => (flag === null ? null : { value: flag, revision: "f1" }),
      compareAndDelete: async () => {
        flag = null;
        return { applied: true };
      },
    } as Pick<StorageCollection, "get" | "put" | "getVersioned" | "compareAndDelete"> as StorageCollection;
    const content = { id: "e1", data: { title: "Bonjour", body: "Edited body" } };

    await confirmPendingAiTranslation(content, pending.storage, store, now);
    await clearEditedAiTranslation(content, store, settings(true));

    expect(flag).toBeNull();
  });

  it("does nothing without a pending record, or when another save already took it", async () => {
    const { storage, puts } = flags();
    await expect(
      confirmPendingAiTranslation({ id: "e1", data: saved }, pendingStorage(null).storage, storage, now),
    ).resolves.toBeUndefined();
    const raced = pendingStorage(await pendingRecord(), true);
    await confirmPendingAiTranslation({ id: "e1", data: saved }, raced.storage, storage, now);
    expect(puts).toEqual([]);
  });
});
