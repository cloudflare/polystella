import { describe, expect, it } from "vitest";

import { applyCatalogOverrides, catalogOverrideId, catalogOverrideState, serializeCatalog, type CatalogOverride } from "../src/catalog.js";

function override(key: string, value: string, locale = "ja-JP"): CatalogOverride {
  return { locale, key, value, updatedAt: "2026-09-02T00:00:00.000Z", updatedBy: "user-1" };
}

describe("catalog overrides", () => {
  it("uses an unambiguous locale-and-key document id", () => {
    expect(catalogOverrideId("ja-JP", "nav.home")).toBe('["ja-JP","nav.home"]');
  });

  it("derives active, synced, and missing states from deployed values", () => {
    const dictionary = { synced: "Same", active: "Old" };
    expect(catalogOverrideState(dictionary, override("synced", "Same"))).toBe("synced");
    expect(catalogOverrideState(dictionary, override("active", "New"))).toBe("active");
    expect(catalogOverrideState(dictionary, override("missing", "New"))).toBe("missing");
    expect(catalogOverrideState(dictionary, override("__proto__", "Safe"))).toBe("missing");
  });

  it("applies overrides without mutating the deployment dictionary", () => {
    const dictionary = { first: "One", second: "Two" };
    const result = applyCatalogOverrides("ja-JP", dictionary, [override("second", "Ni"), override("first", "Ichi")]);

    expect(result).toEqual({ first: "Ichi", second: "Ni" });
    expect(dictionary).toEqual({ first: "One", second: "Two" });
    expect(serializeCatalog("ja-JP", dictionary, [override("second", "Ni")])).toBe('{\n  "first": "One",\n  "second": "Ni"\n}\n');
  });

  it("rejects mixed locales and duplicate keys", () => {
    expect(() => applyCatalogOverrides("ja-JP", {}, [override("key", "Value", "en-US")])).toThrow("does not match");
    expect(() => applyCatalogOverrides("ja-JP", {}, [override("key", "One"), override("key", "Two")])).toThrow("duplicate override");
  });

  it("supports object-prototype keys and deterministic new-key order", () => {
    const overrides = [override("z", "Last"), override("__proto__", "Safe"), override("a", "First")];
    const result = applyCatalogOverrides("ja-JP", {}, overrides);

    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toBe("Safe");
    expect(serializeCatalog("ja-JP", {}, overrides)).toBe('{\n  "__proto__": "Safe",\n  "a": "First",\n  "z": "Last"\n}\n');
  });
});
