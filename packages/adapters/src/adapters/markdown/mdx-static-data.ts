import type { Root } from "mdast";

import type { MarkdownCollectedSegment } from "./extract.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";
import { getPatternMatcher, readArrayProperty, walkUnknown } from "./mdx-utils.js";

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

export function collectMdxStaticDataSegments(ast: Root, source: string, options: CollectMdxStaticDataOptions): MarkdownCollectedSegment[] {
  const rulesByBinding = new Map(
    resolveBindingRules(options.mdxRules.data, options.sourcePath).map((rule) => [rule.bindingName, rule.pathSpecs]),
  );
  const output: MarkdownCollectedSegment[] = [];
  const occupiedSpans = new Set<string>();
  for (const program of readEstreePrograms(ast)) {
    collectAnnotatedStaticData({ program, source, output, occupiedSpans });
    for (const declarator of readVariableDeclarators(program)) {
      const bindingName = readIdentifierName(readProperty(declarator, "id"));
      if (bindingName === undefined) continue;
      const pathSpecs = rulesByBinding.get(bindingName);
      if (pathSpecs === undefined) continue;
      collectFromStaticLiteral({
        idPrefix: `mdx:data:${bindingName}`,
        node: readProperty(declarator, "init"),
        path: "",
        pathSpecs,
        source,
        output,
        occupiedSpans,
      });
    }
  }
  return output;
}

function resolveBindingRules(dataRules: NormalizedMdxRules["data"], sourcePath: string): BindingRule[] {
  const merged = new Map<string, string[]>();
  for (const [pattern, bindings] of Object.entries(dataRules)) {
    if (!getPatternMatcher(pattern)(sourcePath)) continue;
    for (const [bindingName, paths] of Object.entries(bindings)) {
      const existing = merged.get(bindingName) ?? [];
      for (const path of paths) {
        if (!existing.includes(path)) existing.push(path);
      }
      merged.set(bindingName, existing);
    }
  }
  return [...merged].map(([bindingName, pathSpecs]) => ({ bindingName, pathSpecs }));
}

function collectFromStaticLiteral(args: {
  idPrefix: string;
  node: unknown;
  path: string;
  pathSpecs: string[];
  source: string;
  output: MarkdownCollectedSegment[];
  occupiedSpans: Set<string>;
}): void {
  if (!isNode(args.node)) return;
  if (args.node.type === "ArrayExpression") {
    const elements = readArrayProperty(args.node, "elements");
    if (elements === undefined) return;
    elements.forEach((element, index) => {
      if (element !== null) collectFromStaticLiteral({ ...args, node: element, path: `${args.path}[${index}]` });
    });
    return;
  }
  if (args.node.type === "ObjectExpression") {
    const properties = readArrayProperty(args.node, "properties");
    if (properties === undefined) return;
    for (const property of properties) {
      if (!isNode(property) || property.type !== "Property" || readBooleanProperty(property, "computed") === true) continue;
      const key = readPropertyKey(readProperty(property, "key"));
      if (key === undefined) continue;
      const path = args.path.length > 0 ? `${args.path}.${key}` : key;
      collectFromStaticLiteral({ ...args, node: readProperty(property, "value"), path });
    }
    return;
  }
  if (args.node.type !== "Literal") return;
  const value = readProperty(args.node, "value");
  if (typeof value !== "string" || value.length === 0 || !pathMatches(args.path, args.pathSpecs)) return;
  const range = readRange(args.node);
  if (range === undefined) return;
  const quote = readStringQuote(readStringProperty(args.node, "raw") ?? args.source.slice(range.start, range.end));
  if (quote === undefined) return;
  const span = { start: range.start + 1, end: range.end - 1 };
  const spanKey = `${span.start}:${span.end}`;
  if (args.occupiedSpans.has(spanKey)) return;
  args.occupiedSpans.add(spanKey);
  args.output.push({
    segment: { id: `${args.idPrefix}${args.path}`, text: value },
    kind: "mdx-static-data",
    span,
    replacement: { kind: "js-string", quote },
  });
}

function collectAnnotatedStaticData(args: {
  program: unknown;
  source: string;
  output: MarkdownCollectedSegment[];
  occupiedSpans: Set<string>;
}): void {
  const roots = readLiteralRoots(args.program);
  for (const directive of readTranslateDirectives(args.program)) {
    const root = roots.filter((candidate) => candidate.range.start >= directive.rangeEnd).sort((a, b) => a.range.start - b.range.start)[0];
    if (root === undefined) continue;
    collectFromStaticLiteral({
      idPrefix: `mdx:annotation:${root.range.start}`,
      node: root.node,
      path: "",
      pathSpecs: expandAnnotationPathSpecs(directive.pathSpecs, root.node),
      source: args.source,
      output: args.output,
      occupiedSpans: args.occupiedSpans,
    });
  }
}

function expandAnnotationPathSpecs(pathSpecs: string[], root: unknown): string[] {
  if (!isNode(root) || root.type !== "ArrayExpression") return pathSpecs;
  const expanded: string[] = [];
  for (const spec of pathSpecs) {
    expanded.push(spec);
    if (!spec.startsWith("[") && !spec.includes("[]")) expanded.push(`[].${spec}`);
  }
  return expanded;
}

function readTranslateDirectives(program: unknown): TranslateDirective[] {
  const output: TranslateDirective[] = [];
  for (const comment of readArrayProperty(program, "comments") ?? []) {
    const value = readStringProperty(comment, "value");
    const range = readRange(comment);
    if (value === undefined || range === undefined) continue;
    const pathSpecs = parseTranslateDirective(value);
    if (pathSpecs.length > 0) output.push({ rangeEnd: range.end, pathSpecs });
  }
  return output.sort((a, b) => a.rangeEnd - b.rangeEnd);
}

function parseTranslateDirective(value: string): string[] {
  const cleaned = value
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .join("\n");
  const paths = /@polystella\s+translate\b([\s\S]*)/m.exec(cleaned)?.[1]?.trim();
  if (!paths) return [];
  return paths
    .split(/[\n,]/)
    .map((part) => part.replace(/^\s*-\s*/, "").trim())
    .filter((part) => part.length > 0);
}

function readLiteralRoots(program: unknown): LiteralRoot[] {
  const roots: LiteralRoot[] = [];
  walkUnknown(program, (node) => {
    if (!isNode(node) || (node.type !== "ArrayExpression" && node.type !== "ObjectExpression")) return;
    const range = readRange(node);
    if (range !== undefined) roots.push({ node, range });
  });
  return roots;
}

function pathMatches(actualPath: string, specs: readonly string[]): boolean {
  return specs.some((spec) => pathSpecToRegExp(spec).test(actualPath));
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
  const output: unknown[] = [];
  for (const statement of readArrayProperty(program, "body") ?? []) {
    const declaration = unwrapVariableDeclaration(statement);
    if (declaration !== undefined) output.push(...(readArrayProperty(declaration, "declarations") ?? []));
  }
  return output;
}

function unwrapVariableDeclaration(statement: unknown): unknown | undefined {
  if (!isNode(statement)) return undefined;
  if (statement.type === "VariableDeclaration") return statement;
  if (statement.type !== "ExportNamedDeclaration") return undefined;
  const declaration = readProperty(statement, "declaration");
  return isNode(declaration) && declaration.type === "VariableDeclaration" ? declaration : undefined;
}

function readPropertyKey(key: unknown): string | undefined {
  const identifier = readIdentifierName(key);
  if (identifier !== undefined) return identifier;
  if (!isNode(key) || key.type !== "Literal") return undefined;
  const value = readProperty(key, "value");
  return typeof value === "string" ? value : undefined;
}

function readIdentifierName(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier" ? readStringProperty(node, "name") : undefined;
}

function readStringQuote(raw: string): "'" | '"' | undefined {
  const first = raw[0];
  const last = raw[raw.length - 1];
  return raw.length >= 2 && (first === "'" || first === '"') && first === last ? first : undefined;
}

function readRange(node: unknown): { start: number; end: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const start = range[0];
  const end = range[1];
  return typeof start === "number" && typeof end === "number" ? { start, end } : undefined;
}

function isNode(node: unknown): node is { type: string } {
  return typeof node === "object" && node !== null && typeof (node as { type?: unknown }).type === "string";
}

function readProperty(node: unknown, property: string): unknown {
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>)[property] : undefined;
}

function readStringProperty(node: unknown, property: string): string | undefined {
  const value = readProperty(node, property);
  return typeof value === "string" ? value : undefined;
}

function readBooleanProperty(node: unknown, property: string): boolean | undefined {
  const value = readProperty(node, property);
  return typeof value === "boolean" ? value : undefined;
}
