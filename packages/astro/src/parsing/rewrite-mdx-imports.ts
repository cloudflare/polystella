import path from "node:path";

import { parseMdx } from "./parse.js";

export interface RewriteMdxRelativeImportsForStagingOptions {
  /** Absolute path to the source MDX file the staged bytes came from. */
  sourceFilePath: string;
  /** Absolute path where the translated MDX file will be staged. */
  stagedFilePath: string;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

export function rewriteMdxRelativeImportsForStaging(bytes: string, opts: RewriteMdxRelativeImportsForStagingOptions): string {
  const root = parseMdx(bytes);
  const replacements: Replacement[] = [];

  for (const child of root.children) {
    const program = readEstreeProgram(child);
    const body = program === undefined ? undefined : readArrayProperty(program, "body");
    if (body === undefined) continue;

    for (const statement of body) {
      const source = readStaticImportSource(statement);
      if (source === undefined) continue;

      const specifier = readStringProperty(source, "value");
      const raw = readStringProperty(source, "raw");
      const range = readRange(source);
      if (specifier === undefined || raw === undefined || range === undefined) continue;

      const quote = readStringQuote(raw);
      if (quote === undefined) continue;

      const rewritten = rewriteRelativeSpecifier(specifier, opts);
      if (rewritten === specifier) continue;

      replacements.push({
        start: range.start,
        end: range.end,
        text: quoteString(rewritten, quote),
      });
    }
  }

  if (replacements.length === 0) return bytes;

  let out = bytes;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    if (replacement.start < 0 || replacement.end > out.length || replacement.start >= replacement.end) continue;
    out = `${out.slice(0, replacement.start)}${replacement.text}${out.slice(replacement.end)}`;
  }
  return out;
}

function rewriteRelativeSpecifier(specifier: string, opts: RewriteMdxRelativeImportsForStagingOptions): string {
  const { pathPart, suffix } = splitSpecifierSuffix(specifier);
  if (!pathPart.startsWith(".")) return specifier;

  const absoluteTarget = path.resolve(path.dirname(opts.sourceFilePath), pathPart);
  const stagedDir = path.dirname(opts.stagedFilePath);
  const relative = path.relative(stagedDir, absoluteTarget).split(path.sep).join("/");
  const moduleSpecifier = relative.startsWith(".") ? relative : `./${relative}`;
  return `${moduleSpecifier}${suffix}`;
}

function splitSpecifierSuffix(specifier: string): { pathPart: string; suffix: string } {
  const match = /[?#]/.exec(specifier);
  if (match === null) return { pathPart: specifier, suffix: "" };
  return {
    pathPart: specifier.slice(0, match.index),
    suffix: specifier.slice(match.index),
  };
}

function quoteString(value: string, quote: "'" | '"'): string {
  return `${quote}${value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
}

function readEstreeProgram(node: unknown): unknown | undefined {
  if (!isNode(node) || node.type !== "mdxjsEsm") return undefined;
  const data = readProperty(node, "data");
  if (typeof data !== "object" || data === null) return undefined;
  const estree = readProperty(data, "estree");
  return isNode(estree) && estree.type === "Program" ? estree : undefined;
}

function readStaticImportSource(statement: unknown): unknown | undefined {
  if (!isNode(statement)) return undefined;
  if (statement.type !== "ImportDeclaration" && statement.type !== "ExportNamedDeclaration" && statement.type !== "ExportAllDeclaration") {
    return undefined;
  }
  const source = readProperty(statement, "source");
  return isNode(source) && source.type === "Literal" ? source : undefined;
}

function readRange(node: unknown): { start: number; end: number } | undefined {
  const range = readProperty(node, "range");
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const start = range[0];
  const end = range[1];
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}

function readStringQuote(raw: string): "'" | '"' | undefined {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "'" || first === '"') && first === last) return first;
  return undefined;
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
