import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EMPTY_GLOSSARY, type Glossary, type StyleRule } from "@cloudflare/polystella-core";
import { parse as parseYaml } from "yaml";

import type { CatalogGlossaryConfig } from "./config.js";

export interface LoadGlossariesOptions {
  config: {
    locales: ReadonlyArray<string>;
    glossary?: CatalogGlossaryConfig | undefined;
  };
  projectRoot: URL;
}

export async function loadGlossaries(opts: LoadGlossariesOptions): Promise<Map<string, Glossary>> {
  const { config, projectRoot } = opts;
  if (config.glossary === undefined) return new Map();

  const result = new Map<string, Glossary>();
  if ("file" in config.glossary) {
    const template = config.glossary.file;
    if (!template.includes("{locale}")) {
      throw new Error(`[polystella] glossary.file must contain the "{locale}" placeholder (got: ${JSON.stringify(template)})`);
    }
    const projectRootPath = fileURLToPath(projectRoot);
    for (const locale of config.locales) {
      const absPath = path.resolve(projectRootPath, template.replaceAll("{locale}", locale));
      let raw: string;
      try {
        raw = await readFile(absPath, "utf8");
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (error) {
        throw new Error(`[polystella] failed to parse glossary YAML at ${absPath}: ${errorMessage(error)}`);
      }
      result.set(locale, validateGlossary(parsed ?? {}, absPath));
    }
    return result;
  }

  for (const [locale, data] of Object.entries(config.glossary.inline)) {
    result.set(locale, validateGlossary(data, `inline glossary for locale "${locale}"`));
  }
  return result;
}

export function hashGlossary(glossary: Glossary): string {
  const canonical = JSON.stringify({
    version: glossary.version,
    doNotTranslate: glossary.doNotTranslate,
    preferredTranslations: sortedRecord(glossary.preferredTranslations),
    styleRules: glossary.styleRules.map(canonicaliseStyleRule),
    notes: glossary.notes,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const EMPTY_GLOSSARY_HASH: string = hashGlossary(EMPTY_GLOSSARY);

export function validateGlossary(raw: unknown, context: string): Glossary {
  const data = asRecord(raw);
  const issues: string[] = [];
  if (data === undefined) {
    issues.push("  • <root>: Expected object");
  }

  const value = data ?? {};
  const allowed = new Set(["version", "doNotTranslate", "preferredTranslations", "styleRules", "notes"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`  • ${key}: Unrecognized key`);
  }

  const version = optionalString(value.version, "version", issues);
  const notes = optionalString(value.notes, "notes", issues);
  const doNotTranslate = stringArray(value.doNotTranslate, "doNotTranslate", issues);
  const preferredTranslations = stringRecord(value.preferredTranslations, "preferredTranslations", issues);
  const styleRules = parseStyleRules(value.styleRules, issues);

  if (issues.length > 0) throw new Error(`[polystella] invalid glossary at ${context}:\n${issues.join("\n")}`);
  return {
    version: version ?? "",
    doNotTranslate: Array.from(new Set(doNotTranslate)).sort(),
    preferredTranslations,
    styleRules,
    notes: notes ?? "",
  };
}

function parseStyleRules(value: unknown, issues: string[]): StyleRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("  • styleRules: Expected array");
    return [];
  }
  const rules: StyleRule[] = [];
  for (let index = 0; index < value.length; index++) {
    const rule = asRecord(value[index]);
    if (rule === undefined) {
      issues.push(`  • styleRules.${index}: Expected object`);
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (key !== "category" && key !== "instruction" && key !== "example") {
        issues.push(`  • styleRules.${index}.${key}: Unrecognized key`);
      }
    }
    const category = nonEmptyString(rule.category, `styleRules.${index}.category`, issues);
    const instruction = nonEmptyString(rule.instruction, `styleRules.${index}.instruction`, issues);
    const example = optionalNonEmptyString(rule.example, `styleRules.${index}.example`, issues);
    if (category !== undefined && instruction !== undefined) {
      rules.push({ category, instruction, ...(example === undefined ? {} : { example }) });
    }
  }
  return rules;
}

function optionalString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`  • ${path}: Expected string`);
    return undefined;
  }
  return value;
}

function optionalNonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, path, issues);
}

function nonEmptyString(value: unknown, path: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`  • ${path}: Expected non-empty string`);
    return undefined;
  }
  return value;
}

function stringArray(value: unknown, path: string, issues: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`  • ${path}: Expected array`);
    return [];
  }
  const strings: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = nonEmptyString(value[index], `${path}.${index}`, issues);
    if (item !== undefined) strings.push(item);
  }
  return strings;
}

function stringRecord(value: unknown, path: string, issues: string[]): Record<string, string> {
  if (value === undefined) return {};
  const record = asRecord(value);
  if (record === undefined) {
    issues.push(`  • ${path}: Expected object`);
    return {};
  }
  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    const item = nonEmptyString(entry, `${path}.${key}`, issues);
    if (item !== undefined) strings[key] = item;
  }
  return strings;
}

function canonicaliseStyleRule(rule: StyleRule): { category: string; instruction: string; example?: string } {
  return {
    category: rule.category,
    instruction: rule.instruction,
    ...(rule.example === undefined ? {} : { example: rule.example }),
  };
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
