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

export interface ApplyTranslationsOptions {
  sourcePath?: string | undefined;
  mdxRules?: Parameters<typeof collectMarkdownSegments>[1]["mdxRules"] | undefined;
  frontmatterAdditions?: Record<string, unknown> | undefined;
}

export function applyTranslations(
  ast: Root,
  translations: ReadonlyMap<string, string>,
  source: string,
  options: ApplyTranslationsOptions = {},
): string {
  const additions = options.frontmatterAdditions ?? {};
  const hasAdditions = Object.keys(additions).length > 0;
  if (translations.size === 0 && !hasAdditions) return source;

  const edits: TextEdit[] = [];
  const collected = collectMarkdownSegments(
    ast,
    { sourcePath: options.sourcePath ?? "", frontmatter: {}, mdxRules: options.mdxRules },
    source,
  );
  for (const entry of collected) {
    if (entry.kind === "frontmatter") continue;
    const translation = translations.get(entry.segment.id);
    if (translation === undefined || entry.span === undefined) continue;
    edits.push({
      ...entry.span,
      replacement: formatSegmentReplacement(entry, translation, translations),
      label: entry.segment.id,
    });
  }

  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (frontmatterNode !== undefined) {
    const frontmatterTranslations = collectFrontmatterTranslations(translations);
    if (frontmatterTranslations.size > 0 || hasAdditions) {
      const span = nodeSpan(frontmatterNode);
      if (span !== undefined) {
        const parsed = parseYaml(frontmatterNode.value);
        const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        for (const [path, translation] of frontmatterTranslations) applyFrontmatterTranslation(data, path, translation);
        for (const [key, value] of Object.entries(additions)) data[key] = value;
        const inner = stringifyYaml(data).replace(/\n+$/, "");
        edits.push({ ...span, replacement: `---\n${inner}\n---`, label: "frontmatter" });
      }
    }
  } else if (hasAdditions) {
    const inner = stringifyYaml(additions).replace(/\n+$/, "");
    edits.push({ start: 0, end: 0, replacement: `---\n${inner}\n---\n\n`, label: "frontmatter:add" });
  }

  if (edits.length === 0) return source;
  assertNonOverlappingEdits(edits, options.sourcePath);
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
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
  let output = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        output += "\\\\";
        break;
      case "\n":
        output += "\\n";
        break;
      case "\r":
        output += "\\r";
        break;
      case "\t":
        output += "\\t";
        break;
      case "'":
        output += quote === "'" ? "\\'" : char;
        break;
      case '"':
        output += quote === '"' ? '\\"' : char;
        break;
      default:
        output += char;
    }
  }
  return output;
}

function escapeQuotedAttributeContent(value: string, quote: "'" | '"'): string {
  let output = "";
  for (const char of value) {
    switch (char) {
      case "&":
        output += "&amp;";
        break;
      case "'":
        output += quote === "'" ? "&#39;" : char;
        break;
      case '"':
        output += quote === '"' ? "&quot;" : char;
        break;
      case "\n":
      case "\r":
        output += " ";
        break;
      default:
        output += char;
    }
  }
  return output;
}

function nodeSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const position = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

function collectFrontmatterTranslations(translations: ReadonlyMap<string, string>): Map<string, string> {
  const frontmatter = new Map<string, string>();
  for (const [id, value] of translations) {
    if (id.startsWith("fm:")) frontmatter.set(id.slice(3), value);
  }
  return frontmatter;
}

function applyFrontmatterTranslation(data: Record<string, unknown>, path: string, translation: string): void {
  const arrayMatch = /^([^[]+)\[(\d+)\]$/.exec(path);
  if (arrayMatch !== null) {
    const key = arrayMatch[1];
    const indexText = arrayMatch[2];
    if (key === undefined || indexText === undefined) return;
    const value = data[key];
    const index = Number(indexText);
    if (Array.isArray(value) && index < value.length) value[index] = translation;
    return;
  }
  data[path] = translation;
}
