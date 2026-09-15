import picomatch from "picomatch";

import type { NormalizedMdxRules } from "./mdx-rules.js";

const matcherCache = new Map<string, (path: string) => boolean>();

export function allowedAttributesForElement(elementName: string, rules: NormalizedMdxRules | undefined): Set<string> {
  if (rules === undefined) return new Set();
  const first = elementName[0];
  if (first !== undefined && first.toLowerCase() === first) {
    return new Set([...(rules.htmlAttributes["*"] ?? []), ...(rules.htmlAttributes[elementName] ?? [])]);
  }
  return new Set(rules.components[elementName]?.props ?? []);
}

export function findQuotedAttributeValueSpan(
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

export function isMdxJsxAttribute(node: unknown): node is { type: string; name: string; value: unknown } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxAttribute" && typeof candidate.name === "string";
}

export function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return Array.isArray(value) ? value : undefined;
}

export function readPositionSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const position = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

export function walkUnknown(value: unknown, visitor: (node: unknown) => void): void {
  if (typeof value !== "object" || value === null) return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visitor);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) walkUnknown(child, visitor);
}

export function getPatternMatcher(pattern: string): (path: string) => boolean {
  const cached = matcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  matcherCache.set(pattern, matcher);
  return matcher;
}
