import type { NormalizedMdxRules } from "./mdx-rules.js";
import type { TranslatableBlock } from "./traverse.js";

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
  const inlineNodes = readInlineMdxJsxNodes(block)
    .map((node) => ({ node, span: readPositionSpan(node) }))
    .filter((entry): entry is { node: MdxJsxTextNode; span: { start: number; end: number } } => entry.span !== undefined)
    .filter((entry) => entry.span.start >= span.start && entry.span.end <= span.end)
    .sort((a, b) => a.span.start - b.span.start);

  if (inlineNodes.length === 0) return undefined;

  const placeholders: InlineMdxPlaceholder[] = [];
  let cursor = span.start;
  let text = "";

  inlineNodes.forEach((entry, index) => {
    text += source.slice(cursor, entry.span.start);
    const id = String(index);
    const placeholder = buildPlaceholder(id, entry.node, entry.span, source, rules);
    placeholders.push(placeholder.placeholder);
    text += placeholder.text;
    cursor = entry.span.end;
  });

  text += source.slice(cursor, span.end);
  return { text, placeholders };
}

export function restoreInlineMdxPlaceholders(
  value: string,
  placeholders: readonly InlineMdxPlaceholder[],
  translations?: ReadonlyMap<string, string> | undefined,
): string {
  let output = value;
  for (const placeholder of placeholders) {
    if (placeholder.kind === "wrapper") {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']>([\\s\\S]*?)<\\/ph>`, "g");
      let count = 0;
      output = output.replace(pattern, (_match, inner: string) => {
        count++;
        const opening = applyInlinePlaceholderAttributeTranslations(placeholder.opening, placeholder.attributes, translations);
        return `${opening}${inner}${placeholder.closing}`;
      });
      if (count !== 1) {
        throw new Error(`[polystella] translated segment lost or duplicated inline MDX placeholder id=${placeholder.id}`);
      }
    } else {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']\\s*\\/>`, "g");
      let count = 0;
      output = output.replace(pattern, () => {
        count++;
        return applyInlinePlaceholderAttributeTranslations(placeholder.source, placeholder.attributes, translations);
      });
      if (count !== 1) {
        throw new Error(`[polystella] translated segment lost or duplicated inline MDX placeholder id=${placeholder.id}`);
      }
    }
  }
  if (/<ph\s+id=/.test(output)) {
    throw new Error("[polystella] translated segment contains unknown inline MDX placeholder");
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
): { text: string; placeholder: InlineMdxPlaceholder } {
  const nodeSource = source.slice(nodeSpan.start, nodeSpan.end);
  const attributes = collectPlaceholderAttributes(node, source, nodeSpan, rules);
  if (shouldTreatAsOpaque(node, rules)) {
    return { text: `<ph id="${id}"/>`, placeholder: { id, kind: "opaque", source: nodeSource, attributes } };
  }

  const childSpan = readChildrenSpan(node.children);
  if (childSpan === undefined || childSpan.start < nodeSpan.start || childSpan.end > nodeSpan.end) {
    return { text: `<ph id="${id}"/>`, placeholder: { id, kind: "opaque", source: nodeSource, attributes } };
  }

  const opening = source.slice(nodeSpan.start, childSpan.start);
  const inner = source.slice(childSpan.start, childSpan.end);
  const closing = source.slice(childSpan.end, nodeSpan.end);
  return {
    text: `<ph id="${id}">${inner}</ph>`,
    placeholder: { id, kind: "wrapper", opening, closing, attributes },
  };
}

function collectPlaceholderAttributes(
  node: MdxJsxTextNode,
  source: string,
  nodeSpan: { start: number; end: number },
  rules: NormalizedMdxRules | undefined,
): InlineMdxPlaceholderAttribute[] {
  const allowed = allowedAttributesForElement(node.name, rules);
  if (allowed.size === 0) return [];
  const attributes = readArrayProperty(node, "attributes");
  if (attributes === undefined) return [];

  const out: InlineMdxPlaceholderAttribute[] = [];
  for (const attribute of attributes) {
    if (!isMdxJsxAttribute(attribute)) continue;
    if (!allowed.has(attribute.name)) continue;
    if (typeof attribute.value !== "string" || attribute.value.length === 0) continue;
    const attrSpan = readPositionSpan(attribute);
    if (attrSpan === undefined) continue;
    const valueSpan = findQuotedAttributeValueSpan(source, attrSpan);
    if (valueSpan === undefined) continue;
    out.push({
      id: `mdx:inline-attr:${node.name}.${attribute.name}:${valueSpan.start}`,
      text: attribute.value,
      start: valueSpan.start - nodeSpan.start,
      end: valueSpan.end - nodeSpan.start,
      quote: valueSpan.quote,
    });
  }
  return out;
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
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

function allowedAttributesForElement(elementName: string, rules: NormalizedMdxRules | undefined): Set<string> {
  if (rules === undefined) return new Set();
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
  attrSpan: { start: number; end: number },
): { start: number; end: number; quote: "'" | '"' } | undefined {
  const slice = source.slice(attrSpan.start, attrSpan.end);
  const equalsIndex = slice.indexOf("=");
  if (equalsIndex < 0) return undefined;
  let quoteIndex = equalsIndex + 1;
  while (quoteIndex < slice.length && /\s/.test(slice[quoteIndex] ?? "")) quoteIndex++;
  const quote = slice[quoteIndex];
  if (quote !== "'" && quote !== '"') return undefined;
  const valueStartInSlice = quoteIndex + 1;
  const valueEndInSlice = slice.indexOf(quote, valueStartInSlice);
  if (valueEndInSlice < 0) return undefined;
  return {
    start: attrSpan.start + valueStartInSlice,
    end: attrSpan.start + valueEndInSlice,
    quote,
  };
}

function isMdxJsxAttribute(node: unknown): node is { type: string; name: string; value: unknown } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxAttribute" && typeof candidate.name === "string";
}

function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return Array.isArray(value) ? value : undefined;
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

function shouldTreatAsOpaque(node: MdxJsxTextNode, rules: NormalizedMdxRules | undefined): boolean {
  if (!Array.isArray(node.children) || node.children.length === 0) return true;
  return rules?.components[node.name]?.children === false;
}

function readInlineMdxJsxNodes(block: TranslatableBlock): MdxJsxTextNode[] {
  const out: MdxJsxTextNode[] = [];
  for (const child of block.children) {
    if (isMdxJsxTextNode(child)) out.push(child);
  }
  return out;
}

function isMdxJsxTextNode(node: unknown): node is MdxJsxTextNode {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxTextElement" && typeof candidate.name === "string";
}

function readChildrenSpan(children: unknown[] | undefined): { start: number; end: number } | undefined {
  if (!Array.isArray(children) || children.length === 0) return undefined;
  const first = children[0];
  const last = children[children.length - 1];
  const firstSpan = readPositionSpan(first);
  const lastSpan = readPositionSpan(last);
  if (firstSpan === undefined || lastSpan === undefined) return undefined;
  return { start: firstSpan.start, end: lastSpan.end };
}

function readPositionSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const pos = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = pos?.start?.offset;
  const end = pos?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
