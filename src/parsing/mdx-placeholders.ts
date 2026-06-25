import type { NormalizedMdxRules } from "./mdx-rules.js";
import type { TranslatableBlock } from "./traverse.js";

export type InlineMdxPlaceholder =
  | {
      id: string;
      kind: "wrapper";
      opening: string;
      closing: string;
    }
  | {
      id: string;
      kind: "opaque";
      source: string;
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

export function restoreInlineMdxPlaceholders(value: string, placeholders: readonly InlineMdxPlaceholder[]): string {
  let output = value;
  for (const placeholder of placeholders) {
    if (placeholder.kind === "wrapper") {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']>([\\s\\S]*?)<\\/ph>`, "g");
      let count = 0;
      output = output.replace(pattern, (_match, inner: string) => {
        count++;
        return `${placeholder.opening}${inner}${placeholder.closing}`;
      });
      if (count !== 1) {
        throw new Error(`[polystella] translated segment lost or duplicated inline MDX placeholder id=${placeholder.id}`);
      }
    } else {
      const pattern = new RegExp(`<ph\\s+id=["']${escapeRegExp(placeholder.id)}["']\\s*\\/>`, "g");
      let count = 0;
      output = output.replace(pattern, () => {
        count++;
        return placeholder.source;
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
  if (shouldTreatAsOpaque(node, rules)) {
    return { text: `<ph id="${id}"/>`, placeholder: { id, kind: "opaque", source: nodeSource } };
  }

  const childSpan = readChildrenSpan(node.children);
  if (childSpan === undefined || childSpan.start < nodeSpan.start || childSpan.end > nodeSpan.end) {
    return { text: `<ph id="${id}"/>`, placeholder: { id, kind: "opaque", source: nodeSource } };
  }

  const opening = source.slice(nodeSpan.start, childSpan.start);
  const inner = source.slice(childSpan.start, childSpan.end);
  const closing = source.slice(childSpan.end, nodeSpan.end);
  return {
    text: `<ph id="${id}">${inner}</ph>`,
    placeholder: { id, kind: "wrapper", opening, closing },
  };
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
