import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../../src/parsing/apply.js";
import { extractSegments } from "../../src/parsing/extract.js";
import { parseMarkdown } from "../../src/parsing/parse.js";

/**
 * Identity round-trip over a bundled fixture corpus.
 *
 *   parseMarkdown → extractSegments → applyTranslations(empty Map)
 *   assert output === source
 *
 * The fixtures under `tests/fixtures/parsing/round-trip/` cover the
 * full surface of the `remark-parse + remark-frontmatter +
 * remark-gfm` configuration: every markdown construct the parser
 * recognises has a representative input here. Any byte-level drift
 * in the parser/serializer config surfaces as a failing fixture
 * before it can affect real translations.
 *
 * Adding new fixtures: drop a `.md` file in the fixtures directory;
 * the file list is discovered dynamically at module-load time.
 * Prefer one fixture per concern (lists, tables, footnotes, …)
 * over fat omnibus files; a failure points at the smallest possible
 * reproducer that way.
 */

const FIXTURES_DIR = resolve(fileURLToPath(import.meta.url), "../../fixtures/parsing/round-trip");

const fixtureFiles = readdirSync(FIXTURES_DIR)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("parser round-trip over bundled fixtures", () => {
  it("finds fixture files to test", () => {
    // Sanity: if this fails, the path resolution above is wrong and
    // every other assertion below would be vacuously true.
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  for (const fileName of fixtureFiles) {
    it(`${fileName} survives parse → extract → apply(empty) → stringify unchanged`, () => {
      const path = join(FIXTURES_DIR, fileName);
      const source = readFileSync(path, "utf8");

      const ast = parseMarkdown(source);
      // Run extraction so a crash inside the extractor would surface
      // here even on the no-replacement path.
      extractSegments(
        ast,
        {
          sourcePath: `fixtures/${fileName}`,
          frontmatter: { "fixtures/**": ["title", "metaDescription"] },
        },
        source,
      );
      const output = applyTranslations(ast, new Map(), source);

      expect(output).toBe(source);
    });
  }
});
