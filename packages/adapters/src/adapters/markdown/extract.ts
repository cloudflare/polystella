import type { Segment } from "@cloudflare/polystella-core";
import type { Root, Yaml } from "mdast";
import { parse as parseYaml } from "yaml";

import { collectMdxJsxAttributeSegments } from "./mdx-jsx-attributes.js";
import type { InlineMdxPlaceholder } from "./mdx-placeholders.js";
import { protectInlineMdxJsx } from "./mdx-placeholders.js";
import { collectMdxStaticDataSegments } from "./mdx-static-data.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";
import { getPatternMatcher } from "./mdx-utils.js";
import { inlineSpan, visitTranslatableBlocks } from "./traverse.js";

export interface ExtractOptions {
  sourcePath: string;
  frontmatter: Record<string, string[]>;
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

export function extractSegments(ast: Root, options: ExtractOptions, source: string): Segment[] {
  return collectMarkdownSegments(ast, options, source).map((entry) => entry.segment);
}

export function collectMarkdownSegments(ast: Root, options: ExtractOptions, source: string): MarkdownCollectedSegment[] {
  const segments: MarkdownCollectedSegment[] = [];
  const placeholderSegments: MarkdownCollectedSegment[] = [];

  visitTranslatableBlocks(ast, ({ block, id }) => {
    const span = inlineSpan(block);
    if (span === undefined) return;
    const protectedText = protectInlineMdxJsx(block, source, span, options.mdxRules);
    const text = protectedText?.text ?? source.slice(span.start, span.end);
    if (text.length === 0) return;
    segments.push({
      segment: { id, text },
      kind: "body",
      span,
      ...(protectedText ? { placeholders: protectedText.placeholders } : {}),
    });
    if (protectedText !== undefined) {
      for (const placeholder of protectedText.placeholders) {
        for (const attribute of placeholder.attributes) {
          placeholderSegments.push({ segment: { id: attribute.id, text: attribute.text }, kind: "placeholder-inline-jsx" });
        }
      }
    }
  });

  if (options.mdxRules !== undefined) {
    segments.push(...placeholderSegments);
    segments.push(...collectMdxStaticDataSegments(ast, source, { sourcePath: options.sourcePath, mdxRules: options.mdxRules }));
    segments.push(...collectMdxJsxAttributeSegments(ast, source, { mdxRules: options.mdxRules }));
  }

  const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
  if (frontmatterNode !== undefined) {
    const keys = resolveFrontmatterKeys(options.sourcePath, options.frontmatter);
    if (keys.length > 0) {
      const parsed = parseYaml(frontmatterNode.value);
      const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.length > 0) {
          segments.push({ segment: { id: `fm:${key}`, text: value }, kind: "frontmatter" });
        } else if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (typeof item === "string" && item.length > 0) {
              segments.push({ segment: { id: `fm:${key}[${index}]`, text: item }, kind: "frontmatter" });
            }
          });
        }
      }
    }
  }

  return segments;
}

export function resolveFrontmatterKeys(sourcePath: string, rules: Record<string, string[]>): string[] {
  const matched = new Set<string>();
  for (const [pattern, keys] of Object.entries(rules)) {
    if (!getPatternMatcher(pattern)(sourcePath)) continue;
    for (const key of keys) matched.add(key);
  }
  return [...matched];
}
