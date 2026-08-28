import type { Heading, Paragraph, Root, TableCell } from "mdast";

const TRANSLATABLE_BLOCK_TYPES = new Set(["paragraph", "heading", "tableCell"]);
const RECURSE_INTO_TYPES = new Set([
  "root",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "footnoteDefinition",
  "mdxJsxFlowElement",
]);

export type TranslatableBlock = Paragraph | Heading | TableCell;

export interface BlockVisit {
  block: TranslatableBlock;
  id: string;
}

export function visitTranslatableBlocks(ast: Root, visitor: (visit: BlockVisit) => void): void {
  let index = 0;
  const walk = (node: unknown): void => {
    if (!isMdastLikeNode(node)) return;
    if (TRANSLATABLE_BLOCK_TYPES.has(node.type)) {
      visitor({ block: node as TranslatableBlock, id: `body:${index}` });
      index++;
      return;
    }
    if (RECURSE_INTO_TYPES.has(node.type) && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };
  walk(ast);
}

export function inlineSpan(block: TranslatableBlock): { start: number; end: number } | undefined {
  const first = block.children[0];
  const last = block.children.at(-1);
  const start = first?.position?.start?.offset;
  const end = last?.position?.end?.offset;
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

function isMdastLikeNode(node: unknown): node is { type: string; children?: unknown[] } {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "string";
}
