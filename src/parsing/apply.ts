import type { Root, Yaml } from "mdast";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { collectMarkdownSegments } from "./extract.js";
import { restoreInlineMdxPlaceholders } from "./mdx-placeholders.js";

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
  label: string;
}

/**
 * Replace translatable segments in `source` with their translations
 * and return the new markdown.
 *
 * Splices source text rather than using `remark-stringify` because
 * the stringifier defensively re-escapes characters that round-trip
 * fine in the source (`[citation]` → `\[citation]`, `S&P` → `S\&P`),
 * which would break the byte-identical no-translation round-trip
 * the corpus tests require. Using `position.offset`s from
 * `remark-parse`, we replace just the spans we care about and copy
 * untouched characters verbatim.
 *
 * Both extractor and applier target the children's inline range (not
 * the whole block), so translations may contain their own inline
 * markdown (`**bold**`, `[link](url)`) which re-parses correctly,
 * while block-level markers (`# `, `- `, `> `) outside the splice
 * range are preserved.
 */
export interface ApplyTranslationsOptions {
  /** Forward-slash path relative to `sourceDir`, when known. */
  sourcePath?: string | undefined;
  /** Normalized MDX rules for `.mdx` sources. */
  mdxRules?: Parameters<typeof collectMarkdownSegments>[1]["mdxRules"] | undefined;
  /**
   * Frontmatter keys merged into the translated output. Used by the
   * AI-translation marker injection. Keys here override same-named
   * keys already in the source frontmatter (the marker reflects this
   * build's output, not stale source state).
   *
   * - Source has frontmatter: additions merged alongside in-place
   *   translations; pre-existing un-touched keys survive.
   * - Source has none: a fresh `---\n<yaml>\n---\n\n` block is
   *   prepended at offset 0.
   * - Empty object: no-op (preserves the byte-identical round-trip).
   */
  frontmatterAdditions?: Record<string, unknown>;
}

export function applyTranslations(
  ast: Root,
  translations: Map<string, string>,
  source: string,
  options: ApplyTranslationsOptions = {},
): string {
  const additions = options.frontmatterAdditions ?? {};
  const additionKeys = Object.keys(additions);
  const hasAdditions = additionKeys.length > 0;

  // Round-trip short-circuit: nothing changed, return verbatim.
  if (translations.size === 0 && !hasAdditions) {
    return source;
  }

  // Edits are applied right-to-left so earlier offsets stay valid
  // while we splice.
  const edits: TextEdit[] = [];

  const collected = collectMarkdownSegments(
    ast,
    { sourcePath: options.sourcePath ?? "", frontmatter: {}, mdxRules: options.mdxRules },
    source,
  );
  for (const entry of collected) {
    if (entry.kind === "frontmatter") continue;
    const translation = translations.get(entry.segment.id);
    if (translation === undefined) continue;
    if (!entry.span) continue;
    const replacement = formatSegmentReplacement(entry, translation, translations);
    // Inline span (children's range), not the whole block — keeps
    // heading/list/blockquote markers in place. The extractor reads
    // the same range, so the round-trip works.
    edits.push({ ...entry.span, replacement, label: entry.segment.id });
  }

  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (frontmatterNode) {
    const fmTranslations = collectFrontmatterTranslations(translations);
    if (fmTranslations.size > 0 || hasAdditions) {
      const fmSpan = nodeSpan(frontmatterNode);
      if (fmSpan) {
        const data = parseYaml(frontmatterNode.value) as Record<string, unknown>;
        for (const [path, translation] of fmTranslations) {
          applyFrontmatterTranslation(data, path, translation);
        }
        // Additions overwrite existing same-name keys.
        for (const [key, value] of Object.entries(additions)) {
          data[key] = value;
        }
        // `yaml` appends a trailing newline; strip so the shape
        // between `---` markers matches the input.
        const newInner = stringifyYaml(data).replace(/\n+$/, "");
        edits.push({
          ...fmSpan,
          replacement: `---\n${newInner}\n---`,
          label: "frontmatter",
        });
      }
    }
  } else if (hasAdditions) {
    // No source frontmatter — prepend a fresh block at offset 0. The
    // `\n\n` separates the closing `---` from the body.
    const newInner = stringifyYaml(additions).replace(/\n+$/, "");
    const block = `---\n${newInner}\n---\n\n`;
    edits.push({ start: 0, end: 0, replacement: block, label: "frontmatter:add" });
  }

  if (edits.length === 0) {
    return source;
  }

  assertNonOverlappingEdits(edits, options.sourcePath);
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

function assertNonOverlappingEdits(edits: readonly TextEdit[], sourcePath: string | undefined): void {
  for (const edit of edits) {
    if (edit.start < 0 || edit.end < edit.start) {
      throw new Error(
        `[polystella] invalid markdown replacement span${formatSourcePath(sourcePath)}: ${edit.label} [${edit.start}, ${edit.end})`,
      );
    }
  }

  const occupied = edits.filter((edit) => edit.start < edit.end).sort((a, b) => a.start - b.start || a.end - b.end);
  let previous: TextEdit | undefined;
  for (const edit of occupied) {
    if (previous !== undefined && edit.start < previous.end) {
      throw new Error(
        `[polystella] overlapping markdown replacement spans${formatSourcePath(sourcePath)}: ${previous.label} [${previous.start}, ${previous.end}) overlaps ${edit.label} [${edit.start}, ${edit.end})`,
      );
    }
    previous = edit;
  }
}

function formatSourcePath(sourcePath: string | undefined): string {
  return sourcePath && sourcePath.length > 0 ? ` in ${sourcePath}` : "";
}

function formatSegmentReplacement(
  entry: {
    placeholders?: Parameters<typeof restoreInlineMdxPlaceholders>[1] | undefined;
    replacement?: { kind: "js-string" | "quoted-attribute"; quote: "'" | '"' } | undefined;
  },
  value: string,
  translations: ReadonlyMap<string, string>,
): string {
  const restored = entry.placeholders !== undefined ? restoreInlineMdxPlaceholders(value, entry.placeholders, translations) : value;
  return formatCollectedReplacement(entry.replacement, restored);
}

function formatCollectedReplacement(
  replacement: { kind: "js-string" | "quoted-attribute"; quote: "'" | '"' } | undefined,
  value: string,
): string {
  if (replacement?.kind === "js-string") return escapeJsStringContent(value, replacement.quote);
  if (replacement?.kind === "quoted-attribute") return escapeQuotedAttributeContent(value, replacement.quote);
  return value;
}

function escapeJsStringContent(value: string, quote: "'" | '"'): string {
  let out = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "'":
        out += quote === "'" ? "\\'" : char;
        break;
      case '"':
        out += quote === '"' ? '\\"' : char;
        break;
      default:
        out += char;
        break;
    }
  }
  return out;
}

function escapeQuotedAttributeContent(value: string, quote: "'" | '"'): string {
  let out = "";
  for (const char of value) {
    switch (char) {
      case "&":
        out += "&amp;";
        break;
      case "'":
        out += quote === "'" ? "&#39;" : char;
        break;
      case '"':
        out += quote === '"' ? "&quot;" : char;
        break;
      case "\n":
      case "\r":
        out += " ";
        break;
      default:
        out += char;
        break;
    }
  }
  return out;
}

/** Pull `start`/`end` offsets off an mdast node's position. */
function nodeSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const pos = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = pos?.start?.offset;
  const end = pos?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

/**
 * Pull `fm:*` entries out of the translations map, returning a new map
 * keyed by the path-after-`fm:` (e.g. `title`, `tags[0]`).
 */
function collectFrontmatterTranslations(translations: Map<string, string>): Map<string, string> {
  const fm = new Map<string, string>();
  for (const [id, value] of translations) {
    if (id.startsWith("fm:")) {
      fm.set(id.slice(3), value);
    }
  }
  return fm;
}

/**
 * Apply a single frontmatter translation. `path` is either `key` (top-
 * level scalar) or `key[i]` (i-th element of a top-level array).
 */
function applyFrontmatterTranslation(data: Record<string, unknown>, path: string, translation: string): void {
  const arrayMatch = /^([^[]+)\[(\d+)\]$/.exec(path);
  if (arrayMatch) {
    const [, key, indexStr] = arrayMatch;
    if (key === undefined || indexStr === undefined) return;
    const index = Number(indexStr);
    const arr = data[key];
    if (Array.isArray(arr) && index < arr.length) {
      arr[index] = translation;
    }
    return;
  }
  data[path] = translation;
}
