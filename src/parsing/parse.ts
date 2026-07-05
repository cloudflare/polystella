import type { Root } from "mdast";
import { parse as parseJavaScript, type Comment } from "acorn";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { markdownToMdast, mdxToMdast } from "satteri";
import { unified } from "unified";

export type MarkdownParser = "satteri" | "remark";

export interface MarkdownParseOptions {
  parser?: MarkdownParser | undefined;
}

export const DEFAULT_MARKDOWN_PARSER: MarkdownParser = "satteri";

/**
 * Markdown / MDX → mdast. Two parser paths:
 *
 *   - `parseMarkdown(source)` — pure markdown (CommonMark + GFM +
 *     YAML frontmatter). Supports raw HTML at block level (parsed
 *     as `html` nodes), autolinks (`<https://...>`), and indented
 *     code blocks. Used for `.md` files.
 *
 *   - `parseMdx(source)` — markdown + MDX-specific syntax: ESM
 *     imports/exports (`mdxjsEsm`), block JSX (`mdxJsxFlowElement`),
 *     inline JSX (`mdxJsxTextElement`), and expression bindings
 *     (`mdxFlowExpression`, `mdxTextExpression`). Used for `.mdx`
 *     files.
 *
 * **Why split the parsers.** `remark-mdx` is intentionally stricter
 * than CommonMark — it disables indented code blocks (because four-
 * space indentation conflicts with JSX indentation), autolinks
 * (because `<...>` parses as JSX), and rewrites raw HTML at block
 * level into `mdxJsxFlowElement` nodes. Applying it uniformly to
 * `.md` files would silently change parsing behaviour for input the
 * operator never expected to be MDX. Routing by file extension (in
 * the markdown adapter) keeps each format's parsing rules
 * unsurprising.
 *
 * Synchronous: no transformer plugins in the chain, so `.parse()`
 * suffices and we skip `.run()`.
 */

/** Re-usable plain-markdown processor. */
export function createMarkdownProcessor() {
  return unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);
}

/** Re-usable MDX processor (markdown + JSX + ESM + expressions). */
export function createMdxProcessor() {
  return createMarkdownProcessor().use(remarkMdx);
}

/** Pure: no I/O, no Astro coupling. */
export function parseMarkdown(source: string, opts: MarkdownParseOptions = {}): Root {
  if ((opts.parser ?? DEFAULT_MARKDOWN_PARSER) === "satteri") {
    return markdownToMdast(source) as Root;
  }
  return createMarkdownProcessor().parse(source) as Root;
}

/**
 * Parse MDX source. Accepts everything `parseMarkdown` does, plus
 * MDX-specific syntax. Loses indented code, autolinks, and raw-HTML
 * blocks (the latter become JSX elements).
 */
export function parseMdx(source: string, opts: MarkdownParseOptions = {}): Root {
  if ((opts.parser ?? DEFAULT_MARKDOWN_PARSER) === "satteri") {
    try {
      const ast = mdxToMdast(source) as Root;
      attachSatteriMdxCompat(ast, source);
      return ast;
    } catch {
      // Sätteri's MDX parser is stricter than remark-mdx for some
      // expression shapes. Keep the default usable while callers can
      // still force the legacy parser explicitly with parser: "remark".
    }
  }
  return createMdxProcessor().parse(source) as Root;
}

function attachSatteriMdxCompat(root: Root, source: string): void {
  walk(root, (node) => {
    if (!isNode(node)) return;
    if (node.type === "mdxjsEsm") {
      attachEstreeToMdxEsm(node);
    } else if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      attachPositionsToMdxJsxAttributes(node, source);
    }
  });
}

function attachEstreeToMdxEsm(node: { type: string }): void {
  const value = readStringProperty(node, "value");
  const start = readOffset(node);
  if (value === undefined || start === undefined) return;
  const program = parseEstreeProgram(value, start, readStartLine(node), readStartColumn(node));
  if (program === undefined) return;

  const existingData = readObjectProperty(node, "data") ?? {};
  (node as { data?: Record<string, unknown> }).data = { ...existingData, estree: program };
}

function attachPositionsToMdxJsxAttributes(node: { type: string }, source: string): void {
  const attributes = readArrayProperty(node, "attributes");
  const nodeSpan = readPositionSpan(node);
  if (attributes === undefined || nodeSpan === undefined) return;
  const openingEnd = findOpeningTagEnd(source, nodeSpan.start, nodeSpan.end);
  if (openingEnd === undefined) return;

  let cursor = nodeSpan.start;
  for (const attribute of attributes) {
    if (!isMdxJsxAttribute(attribute)) continue;
    const span = findAttributeSpan(source, cursor, openingEnd, attribute.name);
    if (span === undefined) continue;
    cursor = span.end;
    (attribute as { position?: unknown }).position = positionFromOffsets(source, span.start, span.end);

    if (isMdxJsxAttributeValueExpression(attribute.value) && span.value !== undefined && span.value.kind === "expression") {
      (attribute.value as { position?: unknown }).position = positionFromOffsets(source, span.value.start, span.value.end);
      const rawExpression = source.slice(span.value.start, span.value.end);
      const program = parseEstreeProgram(
        rawExpression,
        span.value.start,
        pointForOffset(source, span.value.start).line,
        pointForOffset(source, span.value.start).column,
      );
      if (program !== undefined) {
        const existingData = readObjectProperty(attribute.value, "data") ?? {};
        (attribute.value as { data?: Record<string, unknown> }).data = { ...existingData, estree: program };
      }
    }
  }
}

function parseEstreeProgram(source: string, offset: number, line: number, column: number): unknown | undefined {
  const comments: Comment[] = [];
  try {
    const program = parseJavaScript(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      ranges: true,
      onComment: comments,
    });
    const withComments = program as unknown as { comments?: Comment[] };
    withComments.comments = comments;
    offsetEstreePositions(program, { offset, line, column });
    return program;
  } catch {
    return undefined;
  }
}

function findOpeningTagEnd(source: string, start: number, end: number): number | undefined {
  let quote: "'" | '"' | undefined;
  let braceDepth = 0;
  for (let i = start; i < end; i++) {
    const char = source[i];
    if (char === undefined) return undefined;
    if (quote !== undefined) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth++;
      continue;
    }
    if (char === "}" && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (char === ">" && braceDepth === 0) return i + 1;
  }
  return undefined;
}

function findAttributeSpan(
  source: string,
  start: number,
  end: number,
  name: string,
):
  | {
      start: number;
      end: number;
      value?: { kind: "expression"; start: number; end: number } | { kind: "quoted"; start: number; end: number };
    }
  | undefined {
  let nameStart = start;
  while (nameStart < end) {
    nameStart = source.indexOf(name, nameStart);
    if (nameStart < 0 || nameStart >= end) return undefined;
    if (isAttributeNameBoundary(source[nameStart - 1]) && isAttributeNameBoundary(source[nameStart + name.length])) break;
    nameStart += name.length;
  }

  let cursor = nameStart + name.length;
  while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor++;
  if (source[cursor] !== "=") return { start: nameStart, end: cursor };
  cursor++;
  while (cursor < end && /\s/.test(source[cursor] ?? "")) cursor++;

  const valueStart = cursor;
  const first = source[cursor];
  if (first === "'" || first === '"') {
    cursor++;
    while (cursor < end) {
      const char = source[cursor];
      if (char === "\\") {
        cursor += 2;
        continue;
      }
      if (char === first) {
        return { start: nameStart, end: cursor + 1, value: { kind: "quoted", start: valueStart + 1, end: cursor } };
      }
      cursor++;
    }
    return undefined;
  }

  if (first === "{") {
    const close = findMatchingBrace(source, cursor, end);
    if (close === undefined) return undefined;
    return { start: nameStart, end: close + 1, value: { kind: "expression", start: valueStart + 1, end: close } };
  }

  while (cursor < end && !/\s|>|\//.test(source[cursor] ?? "")) cursor++;
  return { start: nameStart, end: cursor };
}

function findMatchingBrace(source: string, open: number, end: number): number | undefined {
  let quote: "'" | '"' | "`" | undefined;
  let depth = 0;
  for (let i = open; i < end; i++) {
    const char = source[i];
    if (char === undefined) return undefined;
    if (quote !== undefined) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function isAttributeNameBoundary(char: string | undefined): boolean {
  return char === undefined || /[\s=<>/{}]/.test(char);
}

function positionFromOffsets(
  source: string,
  start: number,
  end: number,
): { start: { offset: number; line: number; column: number }; end: { offset: number; line: number; column: number } } {
  return {
    start: { offset: start, ...pointForOffset(source, start) },
    end: { offset: end, ...pointForOffset(source, end) },
  };
}

function pointForOffset(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < safeOffset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function offsetEstreePositions(value: unknown, base: { offset: number; line: number; column: number }): void {
  if (typeof value !== "object" || value === null) return;

  const record = value as Record<string, unknown>;
  if (typeof record["start"] === "number") record["start"] = record["start"] + base.offset;
  if (typeof record["end"] === "number") record["end"] = record["end"] + base.offset;

  const range = record["range"];
  if (Array.isArray(range) && typeof range[0] === "number" && typeof range[1] === "number") {
    range[0] += base.offset;
    range[1] += base.offset;
  }

  const loc = record["loc"];
  if (typeof loc === "object" && loc !== null) {
    offsetLocPoint((loc as { start?: unknown }).start, base);
    offsetLocPoint((loc as { end?: unknown }).end, base);
  }

  for (const child of Object.values(record)) {
    if (child === loc || child === range) continue;
    if (Array.isArray(child)) {
      for (const item of child) offsetEstreePositions(item, base);
    } else {
      offsetEstreePositions(child, base);
    }
  }
}

function offsetLocPoint(point: unknown, base: { line: number; column: number }): void {
  if (typeof point !== "object" || point === null) return;
  const record = point as Record<string, unknown>;
  const line = record["line"];
  const column = record["column"];
  if (typeof line !== "number" || typeof column !== "number") return;
  record["line"] = line + base.line - 1;
  if (line === 1) record["column"] = column + base.column - 1;
}

function walk(value: unknown, visitor: (node: unknown) => void): void {
  if (typeof value !== "object" || value === null) return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visitor);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) walk(child, visitor);
}

function isNode(node: unknown): node is { type: string } {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "string";
}

function isMdxJsxAttribute(node: unknown): node is { type: string; name: string; value: unknown } {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "mdxJsxAttribute" &&
    typeof (node as { name?: unknown }).name === "string"
  );
}

function isMdxJsxAttributeValueExpression(node: unknown): node is { type: string; value: string } {
  return (
    typeof node === "object" &&
    node !== null &&
    (node as { type?: unknown }).type === "mdxJsxAttributeValueExpression" &&
    typeof (node as { value?: unknown }).value === "string"
  );
}

function readPositionSpan(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const pos = (node as { position?: { start?: { offset?: unknown }; end?: { offset?: unknown } } }).position;
  const start = pos?.start?.offset;
  const end = pos?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return Array.isArray(value) ? value : undefined;
}

function readStringProperty(node: unknown, property: string): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return typeof value === "string" ? value : undefined;
}

function readObjectProperty(node: unknown, property: string): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readOffset(node: unknown): number | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const offset = (node as { position?: { start?: { offset?: unknown } } }).position?.start?.offset;
  return typeof offset === "number" ? offset : undefined;
}

function readStartLine(node: unknown): number {
  if (typeof node !== "object" || node === null) return 1;
  const line = (node as { position?: { start?: { line?: unknown } } }).position?.start?.line;
  return typeof line === "number" ? line : 1;
}

function readStartColumn(node: unknown): number {
  if (typeof node !== "object" || node === null) return 1;
  const column = (node as { position?: { start?: { column?: unknown } } }).position?.start?.column;
  return typeof column === "number" ? column : 1;
}
