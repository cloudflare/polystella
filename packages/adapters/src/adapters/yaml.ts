import type { Segment } from "@cloudflare/polystella-core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { FileAdapter } from "../adapter.js";
import { parsePath, readAtPath, resolveConcretePaths, writeAtPath, type PathSegment } from "../key-paths.js";

export type YamlData = unknown;

export const yamlAdapter: FileAdapter<YamlData> = {
  extensions: [".yaml", ".yml"],

  parse(source) {
    return parseYaml(source) as YamlData;
  },

  extractSegments(parsed, _source, options) {
    const segments: Segment[] = [];
    for (const path of resolveConcretePaths({
      parsed,
      sourcePath: options.sourcePath,
      translatableKeys: options.translatableKeys,
    })) {
      const value = readAtPath(parsed, parsePath(path).segments as PathSegment[]);
      if (typeof value === "string" && value.length > 0) segments.push({ id: path, text: value });
    }
    return segments;
  },

  applyTranslations(parsed, _source, translations, options = {}) {
    const output = structuredClone(parsed) as YamlData;
    for (const [id, translation] of translations) {
      writeAtPath(output, parsePath(id).segments as PathSegment[], translation);
    }
    if (options.topLevelAdditions !== undefined) injectTopLevelAdditions(output, options.topLevelAdditions);
    return stringifyYaml(output);
  },
};

function injectTopLevelAdditions(output: YamlData, additions: Record<string, unknown>): void {
  if (output === null || typeof output !== "object") return;
  if (Array.isArray(output)) {
    for (const entry of output) addToEntry(entry, additions);
    return;
  }
  for (const entry of Object.values(output)) addToEntry(entry, additions);
}

function addToEntry(entry: unknown, additions: Record<string, unknown>): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return;
  Object.assign(entry, additions);
}
