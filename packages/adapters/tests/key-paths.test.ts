import { describe, expect, it } from "vitest";

import { expandPath, formatPath, parsePath, readAtPath, resolveConcretePaths, writeAtPath } from "../src/index.js";

describe("key paths", () => {
  it("parses and formats dotted, indexed, and wildcard paths", () => {
    expect(parsePath("items[3].title")).toEqual({ segments: ["items", 3, "title"], hasWildcard: false });
    expect(parsePath("paths.*.summary")).toEqual({ segments: ["paths", "*", "summary"], hasWildcard: true });
    expect(formatPath(["items", 3, "title"])).toBe("items[3].title");
  });

  it("rejects malformed paths", () => {
    for (const path of ["", ".title", "a..b", "a.", "a[nope]", "a[0", "items[0]title"]) {
      expect(() => parsePath(path)).toThrow();
    }
  });

  it("expands composed array and object wildcards in source order", () => {
    const data = {
      paths: {
        first: [{ summary: "a" }, { summary: "b" }],
        second: [{ summary: "c" }],
      },
    };
    expect(expandPath("paths.*[*].summary", data)).toEqual(["paths.first[0].summary", "paths.first[1].summary", "paths.second[0].summary"]);
  });

  it("reads and writes concrete paths", () => {
    const data = { nested: { items: [{ title: "before" }] } };
    const path = ["nested", "items", 0, "title"] as const;
    expect(readAtPath(data, path)).toBe("before");
    writeAtPath(data, path, "after");
    expect(readAtPath(data, path)).toBe("after");
  });

  it("unions matching glob rules and deduplicates concrete paths", () => {
    const paths = resolveConcretePaths({
      parsed: { items: [{ title: "a" }, { title: "b" }] },
      sourcePath: "data/items.json",
      translatableKeys: {
        "data/**": ["items[*].title"],
        "**/*.json": ["items[0].title"],
      },
    });
    expect(paths).toEqual(["items[0].title", "items[1].title"]);
  });

  it("blocks prototype-chain traversal and writes", () => {
    for (const reserved of ["__proto__", "prototype", "constructor"]) {
      expect(() => parsePath(`a.${reserved}.value`)).toThrow(/reserved/);
    }
    expect(readAtPath({}, ["__proto__"])).toBeUndefined();
    expect(() => writeAtPath({}, ["__proto__"], { polluted: true })).toThrow(/reserved/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
