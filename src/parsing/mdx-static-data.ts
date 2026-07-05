import type { Root } from "mdast";
import picomatch from "picomatch";

import type { MarkdownCollectedSegment } from "./extract.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";

export interface CollectMdxStaticDataOptions {
  sourcePath: string;
  mdxRules: NormalizedMdxRules;
}

interface BindingRule {
  bindingName: string;
  pathSpecs: string[];
}

interface TranslateDirective {
  rangeEnd: number;
  pathSpecs: string[];
}

interface LiteralRoot {
  node: unknown;
  range: { start: number; end: number };
}

const matcherCache = new Map<string, (path: string) => boolean>();

function getMatcher(pattern: string): (path: string) => boolean {
  const cached = matcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  matcherCache.set(pattern, matcher);
  return matcher;
}

export function collectMdxStaticDataSegments(ast: Root, source: string, opts: CollectMdxStaticDataOptions): MarkdownCollectedSegment[] {
  const bindingRules = resolveBindingRules(opts.mdxRules.data, opts.sourcePath);
  const rulesByBinding = new Map(bindingRules.map((rule) => [rule.bindingName, rule.pathSpecs]));
  const out: MarkdownCollectedSegment[] = [];
  const occupiedSpans = new Set<string>();

  for (const program of readEstreePrograms(ast)) {
    collectAnnotatedStaticData({ program, source, out, occupiedSpans });
    for (const declarator of readVariableDeclarators(program)) {
      const bindingName = readIdentifierName(readProperty(declarator, "id"));
      if (bindingName === undefined) continue;
      const pathSpecs = rulesByBinding.get(bindingName);
      if (pathSpecs === undefined) continue;
      const init = readProperty(declarator, "init");
      collectFromStaticLiteral({ idPrefix: `mdx:data:${bindingName}`, node: init, path: "", pathSpecs, source, out, occupiedSpans });
    }
  }

  return out;
}

function resolveBindingRules(dataRules: NormalizedMdxRules["data"], sourcePath: string): BindingRule[] {
  const merged = new Map<string, string[]>();
  for (const [pattern, bindings] of Object.entries(dataRules)) {
    if (!getMatcher(pattern)(sourcePath)) continue;
    for (const [bindingName, paths] of Object.entries(bindings)) {
      const existing = merged.get(bindingName) ?? [];
      for (const path of paths) {
        if (!existing.includes(path)) existing.push(path);
      }
      merged.set(bindingName, existing);
    }
  }
  return [...merged.entries()].map(([bindingName, pathSpecs]) => ({ bindingName, pathSpecs }));
}

function collectFromStaticLiteral(args: {
  idPrefix: string;
  node: unknown;
  path: string;
  pathSpecs: string[];
  source: string;
  out: MarkdownCollectedSegment[];
  occupiedSpans: Set<string>;
}): void {
  if (!isNode(args.node)) return;

  if (args.node.type === "ArrayExpression") {
    const elements = readArrayProperty(args.node, "elements");
    if (elements === undefined) return;
    elements.forEach((element, index) => {
      if (element === null) return;
      collectFromStaticLiteral({ ...args, node: element, path: `${args.path}[${index}]` });
    });
    return;
  }

  if (args.node.type === "ObjectExpression") {
    const properties = readArrayProperty(args.node, "properties");
    if (properties === undefined) return;
    for (const property of properties) {
      if (!isNode(property) || property.type !== "Property") continue;
      if (readBooleanProperty(property, "computed") === true) continue;
      const key = readPropertyKey(readProperty(property, "key"));
      if (key === undefined) continue;
      const nextPath = args.path.length > 0 ? `${args.path}.${key}` : key;
      collectFromStaticLiteral({ ...args, node: readProperty(property, "value"), path: nextPath });
    }
    return;
  }

  if (args.node.type !== "Literal") return;
  const value = readProperty(args.node, "value");
  if (typeof value !== "string" || value.length === 0) return;
  if (!pathMatches(args.path, args.pathSpecs)) return;
  const range = readRange(args.node);
  if (range === undefined) return;
  const raw = readStringProperty(args.node, "raw") ?? args.source.slice(range.start, range.end);
  const quote = readStringQuote(raw);
  if (quote === undefined) return;
  const span = { start: range.start + 1, end: range.end - 1 };
  const spanKey = `${span.start}:${span.end}`;
  if (args.occupiedSpans.has(spanKey)) return;
  args.occupiedSpans.add(spanKey);
  args.out.push({
    segment: { id: `${args.idPrefix}${args.path}`, text: value },
    kind: "mdx-static-data",
    span,
    replacement: { kind: "js-string", quote },
  });
}

function collectAnnotatedStaticData(args: {
  program: unknown;
  source: string;
  out: MarkdownCollectedSegment[];
  occupiedSpans: Set<string>;
}): void {
  const directives = readTranslateDirectives(args.program);
  if (directives.length === 0) return;
  const roots = readLiteralRoots(args.program);
  for (const directive of directives) {
    const root = roots.filter((candidate) => candidate.range.start >= directive.rangeEnd).sort((a, b) => a.range.start - b.range.start)[0];
    if (root === undefined) continue;
    const pathSpecs = expandAnnotationPathSpecs(directive.pathSpecs, root.node);
    collectFromStaticLiteral({
      idPrefix: `mdx:annotation:${root.range.start}`,
      node: root.node,
      path: "",
      pathSpecs,
      source: args.source,
      out: args.out,
      occupiedSpans: args.occupiedSpans,
    });
  }
}

function expandAnnotationPathSpecs(pathSpecs: string[], root: unknown): string[] {
  if (!isNode(root) || root.type !== "ArrayExpression") return pathSpecs;
  const expanded: string[] = [];
  for (const spec of pathSpecs) {
    expanded.push(spec);
    if (!spec.startsWith("[") && !spec.includes("[]")) {
      expanded.push(`[].${spec}`);
    }
  }
  return expanded;
}

function readTranslateDirectives(program: unknown): TranslateDirective[] {
  const comments = readArrayProperty(program, "comments") ?? [];
  const out: TranslateDirective[] = [];
  for (const comment of comments) {
    const value = readStringProperty(comment, "value");
    if (value === undefined) continue;
    const range = readRange(comment);
    if (range === undefined) continue;
    const pathSpecs = parseTranslateDirective(value);
    if (pathSpecs.length === 0) continue;
    out.push({ rangeEnd: range.end, pathSpecs });
  }
  return out.sort((a, b) => a.rangeEnd - b.rangeEnd);
}

function parseTranslateDirective(value: string): string[] {
  const cleaned = value
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .join("\n");
  const match = /@polystella\s+translate\b([\s\S]*)/m.exec(cleaned);
  const rawPaths = match?.[1]?.trim();
  if (!rawPaths) return [];
  return rawPaths
    .split(/[\n,]/)
    .map((part) => part.replace(/^\s*-\s*/, "").trim())
    .filter((part) => part.length > 0);
}

function readLiteralRoots(program: unknown): LiteralRoot[] {
  const roots: LiteralRoot[] = [];
  walkUnknown(program, (node) => {
    if (!isNode(node)) return;
    if (node.type !== "ArrayExpression" && node.type !== "ObjectExpression") return;
    const range = readRange(node);
    if (range === undefined) return;
    roots.push({ node, range });
  });
  return roots;
}

function walkUnknown(value: unknown, visitor: (node: unknown) => void): void {
  if (typeof value !== "object" || value === null) return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visitor);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    walkUnknown(child, visitor);
  }
}

function pathMatches(actualPath: string, specs: readonly string[]): boolean {
  for (const spec of specs) {
    if (pathSpecToRegExp(spec).test(actualPath)) return true;
  }
  return false;
}

function pathSpecToRegExp(spec: string): RegExp {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\[\\\]/g, "\\[\\d+\\]")}$`);
}

function readEstreePrograms(root: unknown): unknown[] {
  const programs: unknown[] = [];
  walkUnknown(root, (node) => {
    const program = readEstreeProgram(node);
    if (program !== undefined && !programs.includes(program)) programs.push(program);
  });
  return programs;
}

function readEstreeProgram(node: unknown): unknown | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const data = (node as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const estree = (data as { estree?: unknown }).estree;
  return isNode(estree) && estree.type === "Program" ? estree : undefined;
}

function readVariableDeclarators(program: unknown): unknown[] {
  if (!isNode(program)) return [];
  const body = readArrayProperty(program, "body");
  if (body === undefined) return [];
  const out: unknown[] = [];
  for (const statement of body) {
    const declaration = unwrapVariableDeclaration(statement);
    if (declaration === undefined) continue;
    const declarations = readArrayProperty(declaration, "declarations");
    if (declarations === undefined) continue;
    out.push(...declarations);
  }
  return out;
}

function unwrapVariableDeclaration(statement: unknown): unknown | undefined {
  if (!isNode(statement)) return undefined;
  if (statement.type === "VariableDeclaration") return statement;
  if (statement.type === "ExportNamedDeclaration") {
    const declaration = readProperty(statement, "declaration");
    return isNode(declaration) && declaration.type === "VariableDeclaration" ? declaration : undefined;
  }
  return undefined;
}

function readPropertyKey(key: unknown): string | undefined {
  const identifier = readIdentifierName(key);
  if (identifier !== undefined) return identifier;
  if (!isNode(key) || key.type !== "Literal") return undefined;
  const value = readProperty(key, "value");
  return typeof value === "string" ? value : undefined;
}

function readIdentifierName(node: unknown): string | undefined {
  if (!isNode(node) || node.type !== "Identifier") return undefined;
  return readStringProperty(node, "name");
}

function readStringQuote(raw: string): "'" | '"' | undefined {
  if (raw.length < 2) return undefined;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" || first === '"') && first === last) return first;
  return undefined;
}

function readRange(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const start = range[0];
  const end = range[1];
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

function isNode(node: unknown): node is { type: string } {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "string";
}

function readProperty(node: unknown, property: string): unknown {
  if (typeof node !== "object" || node === null) return undefined;
  return (node as Record<string, unknown>)[property];
}

function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  const value = readProperty(node, property);
  return Array.isArray(value) ? value : undefined;
}

function readStringProperty(node: unknown, property: string): string | undefined {
  const value = readProperty(node, property);
  return typeof value === "string" ? value : undefined;
}

function readBooleanProperty(node: unknown, property: string): boolean | undefined {
  const value = readProperty(node, property);
  return typeof value === "boolean" ? value : undefined;
}
