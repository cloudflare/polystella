import type { Root } from "mdast";

import type { MarkdownCollectedSegment } from "./extract.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";

export interface CollectMdxJsxAttributeOptions {
  mdxRules: NormalizedMdxRules;
}

export function collectMdxJsxAttributeSegments(
  ast: Root,
  source: string,
  options: CollectMdxJsxAttributeOptions,
): MarkdownCollectedSegment[] {
  const output: MarkdownCollectedSegment[] = [];
  walkUnknown(ast, (node) => {
    if (!isMdxJsxElement(node)) return;
    const attributes = readArrayProperty(node, "attributes");
    if (attributes === undefined) return;
    const allowed = allowedAttributesForElement(node.name, options.mdxRules);
    for (const attribute of attributes) {
      if (!isMdxJsxAttribute(attribute) || !allowed.has(attribute.name)) continue;
      if (typeof attribute.value !== "string" || attribute.value.length === 0) continue;
      const attributeSpan = readPositionSpan(attribute);
      if (attributeSpan === undefined) continue;
      const valueSpan = findQuotedAttributeValueSpan(source, attributeSpan);
      if (valueSpan === undefined) continue;
      output.push({
        segment: { id: `mdx:attr:${node.name}.${attribute.name}:${valueSpan.start}`, text: attribute.value },
        kind: "jsx-attribute",
        span: { start: valueSpan.start, end: valueSpan.end },
        replacement: { kind: "quoted-attribute", quote: valueSpan.quote },
      });
    }
  });
  return output;
}

function allowedAttributesForElement(elementName: string, rules: NormalizedMdxRules): Set<string> {
  if (isLowercaseElementName(elementName)) {
    return new Set([...(rules.htmlAttributes["*"] ?? []), ...(rules.htmlAttributes[elementName] ?? [])]);
  }
  return new Set(rules.components[elementName]?.props ?? []);
}

function isLowercaseElementName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first.toLowerCase() === first;
}

function findQuotedAttributeValueSpan(
  source: string,
  attributeSpan: { start: number; end: number },
): { start: number; end: number; quote: "'" | '"' } | undefined {
  const slice = source.slice(attributeSpan.start, attributeSpan.end);
  const equalsIndex = slice.indexOf("=");
  if (equalsIndex < 0) return undefined;
  let quoteIndex = equalsIndex + 1;
  while (quoteIndex < slice.length && /\s/.test(slice[quoteIndex] ?? "")) quoteIndex++;
  const quote = slice[quoteIndex];
  if (quote !== "'" && quote !== '"') return undefined;
  const valueStart = quoteIndex + 1;
  const valueEnd = slice.indexOf(quote, valueStart);
  if (valueEnd < 0) return undefined;
  return { start: attributeSpan.start + valueStart, end: attributeSpan.start + valueEnd, quote };
}

function isMdxJsxElement(node: unknown): node is { type: string; name: string } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxFlowElement" && typeof candidate.name === "string";
}

function isMdxJsxAttribute(node: unknown): node is { type: string; name: string; value: unknown } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxAttribute" && typeof candidate.name === "string";
}

function readPositionSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const position = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

function walkUnknown(value: unknown, visitor: (node: unknown) => void): void {
  if (typeof value !== "object" || value === null) return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visitor);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) walkUnknown(child, visitor);
}

function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return Array.isArray(value) ? value : undefined;
}
