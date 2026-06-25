import { createHash } from "node:crypto";

import picomatch from "picomatch";

import type { PolyStellaResolvedOptions } from "../config/options.js";

export const MDX_RULES_VERSION = "mdx-rules-v1";

export const DEFAULT_MDX_HTML_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "*": ["alt", "title", "aria-label", "placeholder"],
};

type ResolvedMdxOptions = PolyStellaResolvedOptions["markdown"]["mdx"];
type ResolvedMdxRecipeEntry = ResolvedMdxOptions["recipes"][number];
type ResolvedMdxRuleFragment = Omit<ResolvedMdxOptions, "recipes">;

interface ScopedMdxRecipe {
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  use: ResolvedMdxRuleFragment;
}

export interface NormalizedMdxComponentRule {
  children?: boolean | undefined;
  props: string[];
}

export interface NormalizedMdxRules {
  version: typeof MDX_RULES_VERSION;
  htmlAttributes: Record<string, string[]>;
  components: Record<string, NormalizedMdxComponentRule>;
  data: Record<string, Record<string, string[]>>;
}

const matcherCache = new Map<string, (path: string) => boolean>();

function getMatcher(pattern: string): (path: string) => boolean {
  const cached = matcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  matcherCache.set(pattern, matcher);
  return matcher;
}

export function normalizeMdxRulesForSource(mdx: ResolvedMdxOptions, sourcePath: string): NormalizedMdxRules {
  const normalized: NormalizedMdxRules = {
    version: MDX_RULES_VERSION,
    htmlAttributes: cloneStringArrayRecord(DEFAULT_MDX_HTML_ATTRIBUTES),
    components: {},
    data: {},
  };

  for (const recipe of mdx.recipes) {
    if (isScopedRecipe(recipe)) {
      if (!recipeApplies(recipe, sourcePath)) continue;
      mergeFragment(normalized, recipe.use);
    } else {
      mergeFragment(normalized, recipe);
    }
  }

  mergeFragment(normalized, mdx);

  return normalized;
}

export function computeMdxRulesPolicyHash(rules: NormalizedMdxRules): string {
  return createHash("sha256").update(canonicalJSON(rules), "utf8").digest("hex");
}

function recipeApplies(recipe: ScopedMdxRecipe, sourcePath: string): boolean {
  if (recipe.include !== undefined && recipe.include.length > 0 && !matchesAny(recipe.include, sourcePath)) {
    return false;
  }
  if (recipe.exclude !== undefined && recipe.exclude.length > 0 && matchesAny(recipe.exclude, sourcePath)) {
    return false;
  }
  return true;
}

function matchesAny(patterns: readonly string[], sourcePath: string): boolean {
  for (const pattern of patterns) {
    if (getMatcher(pattern)(sourcePath)) return true;
  }
  return false;
}

function mergeFragment(target: NormalizedMdxRules, fragment: ResolvedMdxRuleFragment): void {
  for (const [tagName, attributes] of Object.entries(fragment.htmlAttributes ?? {})) {
    target.htmlAttributes[tagName] = [...attributes];
  }

  for (const [componentName, rule] of Object.entries(fragment.components ?? {})) {
    const existing = target.components[componentName];
    const next: NormalizedMdxComponentRule = { props: existing?.props ? [...existing.props] : [] };
    if (existing?.children !== undefined) {
      next.children = existing.children;
    }
    if (rule.children !== undefined) {
      next.children = rule.children;
    }
    if (rule.props !== undefined) {
      next.props = [...rule.props];
    }
    target.components[componentName] = next;
  }

  for (const [pattern, exportRules] of Object.entries(fragment.data ?? {})) {
    const targetForPattern = target.data[pattern] ?? {};
    for (const [exportName, paths] of Object.entries(exportRules)) {
      targetForPattern[exportName] = [...paths];
    }
    target.data[pattern] = targetForPattern;
  }
}

function cloneStringArrayRecord(record: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(record)) {
    out[key] = [...values];
  }
  return out;
}

function isScopedRecipe(recipe: ResolvedMdxRecipeEntry): recipe is ScopedMdxRecipe {
  return typeof recipe === "object" && recipe !== null && "use" in recipe;
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJSON(entryValue)}`).join(",")}}`;
}
