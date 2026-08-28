import type { Segment } from "@cloudflare/polystella-core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import type { FileAdapter } from "../adapter.js";
import { parsePath, readAtPath, resolveConcretePaths, writeAtPath, type PathSegment } from "../key-paths.js";

export type TomlData = Record<string, unknown>;

export const tomlAdapter: FileAdapter<TomlData> = {
  extensions: [".toml"],

  parse(source) {
    return parseToml(source) as TomlData;
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
    const output = structuredClone(parsed) as TomlData;
    for (const [id, translation] of translations) {
      writeAtPath(output, parsePath(id).segments as PathSegment[], translation);
    }
    if (options.topLevelAdditions !== undefined) {
      for (const entry of Object.values(output)) {
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) Object.assign(entry, options.topLevelAdditions);
      }
    }
    return stringifyToml(output);
  },
};
