import type { Root, Yaml } from "mdast";
import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import { collectMdxJsxAttributeSegments } from "./mdx-jsx-attributes.js";
import type { InlineMdxPlaceholder } from "./mdx-placeholders.js";
import { protectInlineMdxJsx } from "./mdx-placeholders.js";
import { collectMdxStaticDataSegments } from "./mdx-static-data.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";
import { inlineSpan, visitTranslatableBlocks } from "./traverse.js";

/**
 * Per-pattern compiled-matcher cache. Pattern strings are de facto
 * bounded by config (operator declares a small set of globs), so an
 * unbounded Map is safe and avoids re-compiling on every source.
 */
const patternMatcherCache = new Map<string, (path: string) => boolean>();
function getMatcher(pattern: string): (path: string) => boolean {
  const cached = patternMatcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  patternMatcherCache.set(pattern, matcher);
  return matcher;
}

/**
 * A translatable unit. IDs are stable across re-runs and shared with
 * `apply.ts` for byte-replacement at matching positions.
 *
 * ID grammar:
 *   body:<n>          n-th translatable block in DFS order
 *   fm:<key>          frontmatter scalar at top-level <key>
 *   fm:<key>[<i>]     i-th element of a top-level string-array
 */
export interface Segment {
  id: string;
  text: string;
}

export interface ExtractOptions {
  /** Forward-slash path relative to `sourceDir`. */
  sourcePath: string;
  /** Per-glob → translatable frontmatter keys. */
  frontmatter: Record<string, string[]>;
  /** Normalized MDX rules for `.mdx` sources. */
  mdxRules?: NormalizedMdxRules | undefined;
}

export type MarkdownSegmentKind = "body" | "frontmatter" | "mdx-static-data" | "jsx-attribute" | "placeholder-inline-jsx";

export interface MarkdownCollectedSegment {
  segment: Segment;
  kind: MarkdownSegmentKind;
  span?: { start: number; end: number } | undefined;
  replacement?: { kind: "js-string" | "quoted-attribute"; quote: "'" | '"' } | undefined;
  placeholders?: InlineMdxPlaceholder[] | undefined;
}

/**
 * Body segments preserve inline formatting markers (`**bold**` etc.)
 * verbatim — the model preserves them and the applier byte-replaces
 * the same range, keeping block markers (`#`, `> `, `- `) intact.
 * Frontmatter segments hold parsed YAML scalars.
 */
export function extractSegments(ast: Root, opts: ExtractOptions, source: string): Segment[] {
  return collectMarkdownSegments(ast, opts, source).map((entry) => entry.segment);
}

export function collectMarkdownSegments(ast: Root, opts: ExtractOptions, source: string): MarkdownCollectedSegment[] {
  const segments: MarkdownCollectedSegment[] = [];

  visitTranslatableBlocks(ast, ({ block, id }) => {
    const span = inlineSpan(block);
    if (!span) return;
    const protectedText = protectInlineMdxJsx(block, source, span, opts.mdxRules);
    const text = protectedText?.text ?? source.slice(span.start, span.end);
    if (text.length > 0) {
      segments.push({
        segment: { id, text },
        kind: "body",
        span,
        ...(protectedText !== undefined ? { placeholders: protectedText.placeholders } : {}),
      });
    }
  });

  if (opts.mdxRules !== undefined) {
    segments.push(...collectMdxStaticDataSegments(ast, source, { sourcePath: opts.sourcePath, mdxRules: opts.mdxRules }));
    segments.push(...collectMdxJsxAttributeSegments(ast, source, { mdxRules: opts.mdxRules }));
  }

  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (frontmatterNode) {
    const keys = resolveFrontmatterKeys(opts.sourcePath, opts.frontmatter);
    if (keys.length > 0) {
      // Empty / whitespace-only / non-object YAML parses to null,
      // undefined, or a scalar. Coerce to an empty record so the
      // configured keys silently miss instead of crashing on a
      // null-property access. Real-world trigger: a `---\n---`
      // block with no content (intentional or stripped by a tool).
      const parsed = parseYaml(frontmatterNode.value);
      const data: Record<string, unknown> =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      for (const key of keys) {
        const value = data[key];
        // Empty strings emit no segment — translating "" is meaningless
        // and provokes empty-response failures from small instruct
        // models. Mirrors the `text.length > 0` guard the body
        // extractor uses for inline spans, and the equivalent check
        // in the structured-data adapters (TOML / JSON / YAML).
        if (typeof value === "string" && value.length > 0) {
          segments.push({ segment: { id: `fm:${key}`, text: value }, kind: "frontmatter" });
        } else if (Array.isArray(value)) {
          value.forEach((item, i) => {
            if (typeof item === "string" && item.length > 0) {
              segments.push({ segment: { id: `fm:${key}[${i}]`, text: item }, kind: "frontmatter" });
            }
          });
        }
        // Numbers, dates, nested objects, mixed-type arrays: not translatable.
      }
    }
  }

  return segments;
}

/**
 * Resolve which frontmatter keys to translate for `sourcePath`, by
 * unioning the key lists of every matching glob in `rules`.
 */
export function resolveFrontmatterKeys(sourcePath: string, rules: Record<string, string[]>): string[] {
  const matched = new Set<string>();
  for (const [pattern, keys] of Object.entries(rules)) {
    if (getMatcher(pattern)(sourcePath)) {
      for (const key of keys) {
        matched.add(key);
      }
    }
  }
  return [...matched];
}

/**
 * Read the `noTranslate` flag. Returns `true` for boolean `true` and
 * the string aliases `"true"` / `"yes"` (common in hand-edited YAML);
 * everything else returns `false`. Build hook uses this to skip the
 * translation loop entirely.
 */
export function peekNoTranslate(ast: Root): boolean {
  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (!frontmatterNode) return false;

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterNode.value);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const value = (parsed as Record<string, unknown>).noTranslate;
  if (value === true) return true;
  if (typeof value === "string") {
    const normalised = value.toLowerCase().trim();
    return normalised === "true" || normalised === "yes";
  }
  return false;
}

/**
 * Translatable-frontmatter values keyed by name. Feeds the cache-key
 * hash directly (separate from `extractSegments`'s flat `{id, text}`
 * shape so reordering / adding non-translatable keys is invisible to
 * the hash; non-string values still propagate to the hash so e.g. a
 * `year: 2025 → 2026` change re-keys the cache).
 */
export function selectTranslatableFrontmatter(ast: Root, opts: ExtractOptions): Record<string, unknown> {
  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (!frontmatterNode) return {};

  const keys = resolveFrontmatterKeys(opts.sourcePath, opts.frontmatter);
  if (keys.length === 0) return {};

  // Same defensive coercion as `extractSegments`: empty / non-object
  // YAML (e.g. `---\n---`) parses to null and `key in null` throws.
  const parsed = parseYaml(frontmatterNode.value);
  const data: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in data) {
      result[key] = data[key];
    }
  }
  return result;
}
