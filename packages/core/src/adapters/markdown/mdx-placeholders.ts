import type { NormalizedMdxRules } from "./mdx-rules.js";
import {
  allowedAttributesForElement,
  findQuotedAttributeValueSpan,
  isMdxJsxAttribute,
  readArrayProperty,
  readPositionSpan,
} from "./mdx-utils.js";
import type { TranslatableBlock } from "./traverse.js";

export class MdxPlaceholderError extends Error {
  readonly _tag = "MdxPlaceholderError" as const;

  constructor(message: string) {
    super(message);
    this.name = "MdxPlaceholderError";
  }
}

export interface InlineMdxPlaceholderAttribute {
  id: string;
  text: string;
  start: number;
  end: number;
  quote: "'" | '"';
}

export type InlineMdxPlaceholder =
  | {
      id: string;
      kind: "wrapper";
      opening: string;
      closing: string;
      attributes: InlineMdxPlaceholderAttribute[];
    }
  | {
      id: string;
      kind: "opaque";
      source: string;
      attributes: InlineMdxPlaceholderAttribute[];
    };

export interface ProtectedInlineMdxText {
  text: string;
  placeholders: InlineMdxPlaceholder[];
}

export function protectInlineMdxJsx(
  block: TranslatableBlock,
  source: string,
  span: { start: number; end: number },
  rules: NormalizedMdxRules | undefined,
): ProtectedInlineMdxText | undefined {
  const placeholders: InlineMdxPlaceholder[] = [];
  let nextId = 0;

  const protectRange = (nodes: readonly unknown[], range: { start: number; end: number }): string => {
    const inlineNodes = readInlineMdxJsxNodes(nodes)
      .map((node) => ({ node, span: readPositionSpan(node) }))
      .filter((entry): entry is { node: MdxJsxTextNode; span: { start: number; end: number } } => entry.span !== undefined)
      .filter((entry) => entry.span.start >= range.start && entry.span.end <= range.end)
      .sort((a, b) => a.span.start - b.span.start);

    let cursor = range.start;
    let text = "";
    for (const entry of inlineNodes) {
      text += source.slice(cursor, entry.span.start);
      const id = String(nextId++);
      const built = buildPlaceholder(id, entry.node, entry.span, source, rules);
      placeholders.push(built.placeholder);
      text +=
        built.childSpan === undefined
          ? `<ph id="${id}"/>`
          : `<ph id="${id}">${protectRange(entry.node.children ?? [], built.childSpan)}</ph>`;
      cursor = entry.span.end;
    }
    return text + source.slice(cursor, range.end);
  };

  const text = protectRange(block.children, span);
  return placeholders.length > 0 ? { text, placeholders } : undefined;
}

export function restoreInlineMdxPlaceholders(
  value: string,
  placeholders: readonly InlineMdxPlaceholder[],
  translations?: ReadonlyMap<string, string> | undefined,
): string {
  let output = value;
  for (const placeholder of [...placeholders].reverse()) {
    if (placeholder.kind === "wrapper") {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']>([\\s\\S]*?)<\\/ph>`, "g");
      let count = 0;
      output = output.replace(pattern, (_match, inner: string) => {
        count++;
        const opening = applyInlinePlaceholderAttributeTranslations(placeholder.opening, placeholder.attributes, translations);
        return `${opening}${inner}${placeholder.closing}`;
      });
      if (count !== 1) {
        throw new MdxPlaceholderError(`[polystella] translated segment lost or duplicated inline MDX placeholder id=${placeholder.id}`);
      }
    } else {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']\\s*\\/>`, "g");
      let count = 0;
      output = output.replace(pattern, () => {
        count++;
        return applyInlinePlaceholderAttributeTranslations(placeholder.source, placeholder.attributes, translations);
      });
      if (count !== 1) {
        throw new MdxPlaceholderError(`[polystella] translated segment lost or duplicated inline MDX placeholder id=${placeholder.id}`);
      }
    }
  }
  if (/<ph\s+id=/.test(output)) {
    throw new MdxPlaceholderError("[polystella] translated segment contains unknown inline MDX placeholder");
  }
  return output;
}

interface MdxJsxTextNode {
  type: "mdxJsxTextElement";
  name: string;
  attributes?: unknown[] | undefined;
  children?: unknown[] | undefined;
}

function buildPlaceholder(
  id: string,
  node: MdxJsxTextNode,
  nodeSpan: { start: number; end: number },
  source: string,
  rules: NormalizedMdxRules | undefined,
): { placeholder: InlineMdxPlaceholder; childSpan?: { start: number; end: number } | undefined } {
  const nodeSource = source.slice(nodeSpan.start, nodeSpan.end);
  const attributes = collectPlaceholderAttributes(node, source, nodeSpan, rules);
  if (shouldTreatAsOpaque(node, rules)) {
    return { placeholder: { id, kind: "opaque", source: nodeSource, attributes } };
  }
  const childSpan = readChildrenSpan(node.children);
  if (childSpan === undefined || childSpan.start < nodeSpan.start || childSpan.end > nodeSpan.end) {
    return { placeholder: { id, kind: "opaque", source: nodeSource, attributes } };
  }
  return {
    placeholder: {
      id,
      kind: "wrapper",
      opening: source.slice(nodeSpan.start, childSpan.start),
      closing: source.slice(childSpan.end, nodeSpan.end),
      attributes,
    },
    childSpan,
  };
}

function collectPlaceholderAttributes(
  node: MdxJsxTextNode,
  source: string,
  nodeSpan: { start: number; end: number },
  rules: NormalizedMdxRules | undefined,
): InlineMdxPlaceholderAttribute[] {
  const allowed = allowedAttributesForElement(node.name, rules);
  const attributes = readArrayProperty(node, "attributes");
  if (allowed.size === 0 || attributes === undefined) return [];
  const output: InlineMdxPlaceholderAttribute[] = [];
  for (const attribute of attributes) {
    if (!isMdxJsxAttribute(attribute) || !allowed.has(attribute.name)) continue;
    if (typeof attribute.value !== "string" || attribute.value.length === 0) continue;
    const attributeSpan = readPositionSpan(attribute);
    if (attributeSpan === undefined) continue;
    const valueSpan = findQuotedAttributeValueSpan(source, attributeSpan);
    if (valueSpan === undefined) continue;
    output.push({
      id: `mdx:inline-attr:${node.name}.${attribute.name}:${valueSpan.start}`,
      text: attribute.value,
      start: valueSpan.start - nodeSpan.start,
      end: valueSpan.end - nodeSpan.start,
      quote: valueSpan.quote,
    });
  }
  return output;
}

function applyInlinePlaceholderAttributeTranslations(
  source: string,
  attributes: readonly InlineMdxPlaceholderAttribute[],
  translations: ReadonlyMap<string, string> | undefined,
): string {
  if (translations === undefined || attributes.length === 0) return source;
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const attribute of attributes) {
    if (attribute.start < 0 || attribute.end > source.length || attribute.end < attribute.start) continue;
    const translation = translations.get(attribute.id);
    if (translation === undefined) continue;
    edits.push({
      start: attribute.start,
      end: attribute.end,
      replacement: escapeQuotedAttributeContent(translation, attribute.quote),
    });
  }
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
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

function shouldTreatAsOpaque(node: MdxJsxTextNode, rules: NormalizedMdxRules | undefined): boolean {
  if (!Array.isArray(node.children) || node.children.length === 0) return true;
  return rules?.components[node.name]?.children === false;
}

function readInlineMdxJsxNodes(nodes: readonly unknown[]): MdxJsxTextNode[] {
  const output: MdxJsxTextNode[] = [];
  const visit = (node: unknown): void => {
    if (isMdxJsxTextNode(node)) {
      output.push(node);
      return;
    }
    for (const child of readArrayProperty(node, "children") ?? []) visit(child);
  };
  for (const node of nodes) {
    visit(node);
  }
  return output;
}

function isMdxJsxTextNode(node: unknown): node is MdxJsxTextNode {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxTextElement" && typeof candidate.name === "string";
}

function readChildrenSpan(children: unknown[] | undefined): { start: number; end: number } | undefined {
  if (!Array.isArray(children) || children.length === 0) return undefined;
  const firstSpan = readPositionSpan(children[0]);
  const lastSpan = readPositionSpan(children[children.length - 1]);
  return firstSpan !== undefined && lastSpan !== undefined ? { start: firstSpan.start, end: lastSpan.end } : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
