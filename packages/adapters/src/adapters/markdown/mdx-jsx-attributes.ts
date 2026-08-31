import type { Root } from "mdast";

import type { MarkdownCollectedSegment } from "./extract.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";
import {
  allowedAttributesForElement,
  findQuotedAttributeValueSpan,
  isMdxJsxAttribute,
  readArrayProperty,
  readPositionSpan,
  walkUnknown,
} from "./mdx-utils.js";

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

function isMdxJsxElement(node: unknown): node is { type: string; name: string } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxFlowElement" && typeof candidate.name === "string";
}
