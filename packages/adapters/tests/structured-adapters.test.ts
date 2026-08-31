import { describe, expect, it } from "vitest";

import { jsonAdapter, tomlAdapter, yamlAdapter, type FileAdapter } from "../src/index.js";

interface FormatCase {
  name: string;
  adapter: FileAdapter<unknown>;
  source: string;
  expected: string;
}

const formatCases: FormatCase[] = [
  {
    name: "JSON",
    adapter: jsonAdapter,
    source: '{"title":"Hello","nested":{"body":"World"}}',
    expected: '{\n  "title": "X:Hello",\n  "nested": {\n    "body": "X:World",\n    "aiTranslated": true\n  }\n}',
  },
  {
    name: "YAML",
    adapter: yamlAdapter,
    source: "title: Hello\nnested:\n  body: World\n",
    expected: "title: X:Hello\nnested:\n  body: X:World\n  aiTranslated: true\n",
  },
  {
    name: "TOML",
    adapter: tomlAdapter as FileAdapter<unknown>,
    source: 'title = "Hello"\n\n[nested]\nbody = "World"\n',
    expected: 'title = "X:Hello"\n\n[nested]\nbody = "X:World"\naiTranslated = true\n',
  },
];

describe.each(formatCases)("$name adapter", ({ adapter, source, expected }) => {
  const options = { sourcePath: "content/entry.data", translatableKeys: { "content/**": ["title", "nested.body"] } };

  it("matches the Step 1 reconstruction fixture", () => {
    const parsed = adapter.parse(source);
    const segments = adapter.extractSegments(parsed, source, options);
    expect(segments).toEqual([
      { id: "title", text: "Hello" },
      { id: "nested.body", text: "World" },
    ]);
    const translations = new Map(segments.map((segment) => [segment.id, `X:${segment.text}`]));
    expect(adapter.applyTranslations(parsed, source, translations, { topLevelAdditions: { aiTranslated: true } })).toBe(expected);
  });

  it("does not mutate parsed input and generic additions are idempotent", () => {
    const parsed = adapter.parse(source);
    const snapshot = structuredClone(parsed);
    const once = adapter.applyTranslations(parsed, source, new Map(), { topLevelAdditions: { aiTranslated: true } });
    expect(parsed).toEqual(snapshot);
    const twice = adapter.applyTranslations(adapter.parse(once), once, new Map(), { topLevelAdditions: { aiTranslated: true } });
    expect(twice).toBe(once);
  });
});

describe("structured wildcard extraction", () => {
  it.each([
    [jsonAdapter, '{"items":[{"title":"First"},{"title":"Second"}]}'],
    [yamlAdapter, "items:\n  - title: First\n  - title: Second\n"],
    [tomlAdapter, '[[items]]\ntitle = "First"\n\n[[items]]\ntitle = "Second"\n'],
  ] as const)("expands wildcards and ignores non-string fields", (adapter, source) => {
    const portableAdapter = adapter as FileAdapter<unknown>;
    const parsed = portableAdapter.parse(source);
    const segments = portableAdapter.extractSegments(parsed, source, {
      sourcePath: "data/items",
      translatableKeys: { "data/**": ["items[*].title", "items[*].missing"] },
    });
    expect(segments).toEqual([
      { id: "items[0].title", text: "First" },
      { id: "items[1].title", text: "Second" },
    ]);
  });

  it("injects generic additions into top-level JSON and YAML sequence entries", () => {
    for (const [adapter, source] of [
      [jsonAdapter, '[{"id":"a","title":"First"},{"id":"b","title":"Second"}]'],
      [yamlAdapter, "- id: a\n  title: First\n- id: b\n  title: Second\n"],
    ] as const) {
      const portableAdapter = adapter as FileAdapter<unknown>;
      const output = portableAdapter.applyTranslations(portableAdapter.parse(source), source, new Map(), {
        topLevelAdditions: { aiTranslated: true },
      });
      expect(output.match(/aiTranslated/g)).toHaveLength(2);
    }
  });

  it("leaves scalar roots valid and rejects invalid translation paths", () => {
    expect(jsonAdapter.applyTranslations(jsonAdapter.parse('"value"'), '"value"', new Map(), { topLevelAdditions: { marker: true } })).toBe(
      '"value"',
    );
    expect(yamlAdapter.applyTranslations(yamlAdapter.parse("value\n"), "value\n", new Map(), { topLevelAdditions: { marker: true } })).toBe(
      "value\n",
    );
    const parsed = jsonAdapter.parse('{"entry":{"title":"Hello"}}');
    expect(() => jsonAdapter.applyTranslations(parsed, "", new Map([["entry.missing.title", "X"]]))).toThrow(/null\/undefined/);
  });
});
