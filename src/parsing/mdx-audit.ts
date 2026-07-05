import type { Root } from "mdast";
import picomatch from "picomatch";

import type { NormalizedMdxRules } from "./mdx-rules.js";

export type MdxAuditSeverity = "low" | "medium" | "high";

export type MdxAuditCode =
  | "unconfigured-component-prop"
  | "unsupported-expression-prop"
  | "unconfigured-html-attribute"
  | "unannotated-static-data"
  | "unsupported-static-data-shape"
  | "opaque-component-children";

export interface MdxAuditFinding {
  sourcePath: string;
  line: number;
  column: number;
  severity: MdxAuditSeverity;
  code: MdxAuditCode;
  text: string;
  message: string;
  suggestion: string;
}

export interface AuditMdxAstOptions {
  sourcePath: string;
  mdxRules: NormalizedMdxRules;
  /** Original source bytes. Enables static-data audit + ignore comments. */
  source?: string | undefined;
}

interface SourceLocation {
  line: number;
  column: number;
}

interface Range {
  start: number;
  end: number;
}

interface StaticDataCandidate {
  node: EstreeNode;
  range: Range;
  bindingName?: string | undefined;
}

interface StringCandidate {
  text: string;
  loc: SourceLocation;
}

interface TranslateDirective {
  rangeEnd: number;
}

interface LiteralRoot {
  node: EstreeNode;
  range: Range;
}

interface EstreeNode {
  type: string;
}

const TECHNICAL_ATTRS = new Set([
  "class",
  "className",
  "color",
  "data",
  "href",
  "icon",
  "id",
  "name",
  "size",
  "src",
  "type",
  "value",
  "variant",
]);
const LIKELY_COPY_PROPS = new Set([
  "aria-label",
  "ctaLabel",
  "description",
  "eyebrow",
  "headline",
  "label",
  "placeholder",
  "subheadline",
  "subtitle",
  "text",
  "title",
]);

const matcherCache = new Map<string, (path: string) => boolean>();

export function auditMdxAst(ast: Root, opts: AuditMdxAstOptions): MdxAuditFinding[] {
  const findings: MdxAuditFinding[] = [];
  auditJsxAttributes(ast, opts, findings);
  auditOpaqueComponentChildren(ast, opts, findings);
  const source = opts.source;
  if (source !== undefined) {
    auditStaticData(ast, { ...opts, source }, findings);
  }
  return filterIgnoredFindings(findings, opts.source);
}

function auditOpaqueComponentChildren(ast: Root, opts: AuditMdxAstOptions, findings: MdxAuditFinding[]): void {
  walkUnknown(ast, (node) => {
    if (!isMdxJsxElement(node)) return;
    if (isLowercaseElementName(node.name)) return;
    if (opts.mdxRules.components[node.name]?.children === true) return;
    const children = readArrayProperty(node, "children");
    if (children === undefined || children.length === 0) return;
    const candidate = findFirstLikelyVisibleChildText(children, opts.source);
    if (candidate === undefined) return;
    findings.push({
      sourcePath: opts.sourcePath,
      line: candidate.loc.line,
      column: candidate.loc.column,
      severity: "low",
      code: "opaque-component-children",
      text: candidate.text,
      message: `Custom component \`${node.name}\` has child text but is not configured with \`children: true\` for MDX translation.`,
      suggestion: `Add \`${node.name}: { children: true }\` to \`markdown.mdx.components\` or a recipe if this child content is visible copy, or add \`@polystella ignore\` if it is intentionally opaque.`,
    });
  });
}

function auditJsxAttributes(ast: Root, opts: AuditMdxAstOptions, findings: MdxAuditFinding[]): void {
  walkUnknown(ast, (node) => {
    if (!isMdxJsxElement(node)) return;
    const attributes = readArrayProperty(node, "attributes");
    if (attributes === undefined) return;
    for (const attribute of attributes) {
      if (!isMdxJsxAttribute(attribute)) continue;
      const loc = readStartLocation(attribute, opts.source);
      if (loc === undefined) continue;
      const allowed = allowedAttributesForElement(node.name, opts.mdxRules);
      if (typeof attribute.value === "string") {
        const attrValue = attribute.value;
        if (allowed.has(attribute.name)) continue;
        if (!shouldAuditStaticAttribute(node.name, attribute.name, attrValue)) continue;
        findings.push(
          buildStaticAttributeFinding({
            sourcePath: opts.sourcePath,
            elementName: node.name,
            attribute: { name: attribute.name, value: attrValue },
            loc,
          }),
        );
      } else if (isExpressionAttributeValue(attribute.value) && shouldAuditExpressionAttribute(node.name, attribute.name)) {
        findings.push({
          sourcePath: opts.sourcePath,
          line: loc.line,
          column: loc.column,
          severity: "low",
          code: "unsupported-expression-prop",
          text: attribute.value.value,
          message: `JSX expression prop \`${node.name}.${attribute.name}\` is intentionally not translated by MDX content extraction.`,
          suggestion:
            "Use a catalog/runtime `t()` call for dynamic UI copy, or move page-local static copy into annotated/configured static data.",
        });
      }
    }
  });
}

function auditStaticData(ast: Root, opts: AuditMdxAstOptions & { source: string }, findings: MdxAuditFinding[]): void {
  const configuredBindings = resolveConfiguredDataBindings(opts.mdxRules.data, opts.sourcePath);
  for (const program of readEstreePrograms(ast)) {
    const annotatedRanges = readAnnotatedRootRangeKeys(program);
    for (const candidate of readStaticDataCandidates(program)) {
      const isConfigured = candidate.bindingName !== undefined && configuredBindings.has(candidate.bindingName);
      const isAnnotated = annotatedRanges.has(rangeKey(candidate.range));
      const firstCopy = findFirstUserFacingString(candidate.node, opts.source);
      const shouldInspect = isConfigured || isAnnotated || firstCopy !== undefined;
      if (!shouldInspect) continue;

      if (!isConfigured && !isAnnotated && firstCopy !== undefined) {
        findings.push({
          sourcePath: opts.sourcePath,
          line: firstCopy.loc.line,
          column: firstCopy.loc.column,
          severity: "low",
          code: "unannotated-static-data",
          text: firstCopy.text,
          message: "Static MDX data contains likely user-facing copy but is not configured or annotated for translation.",
          suggestion:
            "Add a `@polystella translate` annotation near the literal, add a `markdown.mdx.data` rule for the binding, or add `@polystella ignore` if this data is intentionally not translated.",
        });
      }

      findings.push(...buildUnsupportedStaticDataFindings(candidate.node, opts));
    }
  }
}

function buildUnsupportedStaticDataFindings(root: EstreeNode, opts: AuditMdxAstOptions & { source: string }): MdxAuditFinding[] {
  const findings: MdxAuditFinding[] = [];
  const seen = new Set<string>();
  walkUnknown(root, (node) => {
    if (!isNode(node)) return;
    const kind = unsupportedStaticDataShapeKind(node);
    if (kind === undefined) return;
    const range = readRange(node);
    const loc = readStartLocation(node, opts.source);
    if (range === undefined || loc === undefined) return;
    const key = `${kind}:${range.start}:${range.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      sourcePath: opts.sourcePath,
      line: loc.line,
      column: loc.column,
      severity: "low",
      code: "unsupported-static-data-shape",
      text: sourceSnippet(opts.source, range),
      message: `Static MDX data uses unsupported ${kind}; content extraction only handles literal arrays/objects, non-computed keys, and quoted string values.`,
      suggestion:
        "Rewrite this as literal static data, move dynamic copy into catalog/runtime `t()`, or add `@polystella ignore` if it should not be translated.",
    });
  });
  return findings;
}

function unsupportedStaticDataShapeKind(node: EstreeNode): string | undefined {
  if (node.type === "SpreadElement") return "spread syntax";
  if (node.type === "TemplateLiteral") return "template literal";
  if (node.type === "ConditionalExpression") return "conditional expression";
  if (node.type === "Property" && readBooleanProperty(node, "computed") === true) return "computed key";
  return undefined;
}

function buildStaticAttributeFinding(args: {
  sourcePath: string;
  elementName: string;
  attribute: { name: string; value: string };
  loc: SourceLocation;
}): MdxAuditFinding {
  const isHtml = isLowercaseElementName(args.elementName);
  return {
    sourcePath: args.sourcePath,
    line: args.loc.line,
    column: args.loc.column,
    severity: isHtml ? "low" : "medium",
    code: isHtml ? "unconfigured-html-attribute" : "unconfigured-component-prop",
    text: args.attribute.value,
    message: `Static JSX ${isHtml ? "attribute" : "component prop"} \`${args.elementName}.${args.attribute.name}\` is not configured for translation.`,
    suggestion: isHtml
      ? `Add \`${args.attribute.name}\` to \`markdown.mdx.htmlAttributes.${args.elementName}\` if this is visible copy.`
      : `Add \`${args.attribute.name}\` to \`markdown.mdx.components.${args.elementName}.props\`, import a recipe, or add \`@polystella ignore\` when this is a machine string.`,
  };
}

function shouldAuditStaticAttribute(elementName: string, attrName: string, value: string): boolean {
  if (value.trim().length < 4) return false;
  if (TECHNICAL_ATTRS.has(attrName)) return false;
  if (/^[a-z0-9_-]+$/i.test(value) && !/\s/.test(value)) return false;
  return isLowercaseElementName(elementName) || looksUserFacing(value);
}

function shouldAuditExpressionAttribute(elementName: string, attrName: string): boolean {
  if (TECHNICAL_ATTRS.has(attrName)) return false;
  return !isLowercaseElementName(elementName) && LIKELY_COPY_PROPS.has(attrName);
}

function looksUserFacing(value: string): boolean {
  return /\s/.test(value) || /^[A-Z]/.test(value) || /[.!?]$/.test(value);
}

function allowedAttributesForElement(elementName: string, rules: NormalizedMdxRules): Set<string> {
  if (isLowercaseElementName(elementName)) {
    return new Set([...(rules.htmlAttributes["*"] ?? []), ...(rules.htmlAttributes[elementName] ?? [])]);
  }
  return new Set(rules.components[elementName]?.props ?? []);
}

function isLowercaseElementName(name: string): boolean {
  const first = name[0];
  return first !== undefined && first.toLowerCase() === first;
}

function resolveConfiguredDataBindings(dataRules: NormalizedMdxRules["data"], sourcePath: string): Set<string> {
  const bindings = new Set<string>();
  for (const [pattern, rules] of Object.entries(dataRules)) {
    if (!getMatcher(pattern)(sourcePath)) continue;
    for (const binding of Object.keys(rules)) bindings.add(binding);
  }
  return bindings;
}

function getMatcher(pattern: string): (path: string) => boolean {
  const cached = matcherCache.get(pattern);
  if (cached !== undefined) return cached;
  const matcher = picomatch(pattern);
  matcherCache.set(pattern, matcher);
  return matcher;
}

function readStaticDataCandidates(program: unknown): StaticDataCandidate[] {
  const candidates: StaticDataCandidate[] = [];
  walkWithAncestors(program, [], (node, ancestors) => {
    if (!isStaticLiteralRootNode(node)) return;
    if (hasStaticLiteralAncestor(ancestors)) return;
    const range = readRange(node);
    if (range === undefined) return;
    const bindingName = readCandidateBindingName(node, ancestors);
    candidates.push({ node, range, ...(bindingName !== undefined ? { bindingName } : {}) });
  });
  return candidates;
}

function isStaticLiteralRootNode(node: unknown): node is EstreeNode {
  return isNode(node) && (node.type === "ArrayExpression" || node.type === "ObjectExpression");
}

function hasStaticLiteralAncestor(ancestors: readonly EstreeNode[]): boolean {
  return ancestors.some((ancestor) => ancestor.type === "ArrayExpression" || ancestor.type === "ObjectExpression");
}

function readCandidateBindingName(node: EstreeNode, ancestors: readonly EstreeNode[]): string | undefined {
  const parent = ancestors.at(-1);
  if (parent === undefined || parent.type !== "VariableDeclarator") return undefined;
  if (readProperty(parent, "init") !== node) return undefined;
  return readIdentifierName(readProperty(parent, "id"));
}

function readAnnotatedRootRangeKeys(program: unknown): Set<string> {
  const keys = new Set<string>();
  const roots = readLiteralRoots(program).sort((a, b) => a.range.start - b.range.start);
  const used = new Set<string>();
  for (const directive of readTranslateDirectives(program)) {
    const root = roots.find((candidate) => candidate.range.start >= directive.rangeEnd && !used.has(rangeKey(candidate.range)));
    if (root === undefined) continue;
    const key = rangeKey(root.range);
    used.add(key);
    keys.add(key);
  }
  return keys;
}

function readTranslateDirectives(program: unknown): TranslateDirective[] {
  const comments = readArrayProperty(program, "comments") ?? [];
  const out: TranslateDirective[] = [];
  for (const comment of comments) {
    const value = readStringProperty(comment, "value");
    const range = readRange(comment);
    if (value === undefined || range === undefined) continue;
    if (!/@polystella\s+translate\b/.test(value)) continue;
    out.push({ rangeEnd: range.end });
  }
  return out.sort((a, b) => a.rangeEnd - b.rangeEnd);
}

function readLiteralRoots(program: unknown): LiteralRoot[] {
  const roots: LiteralRoot[] = [];
  walkUnknown(program, (node) => {
    if (!isStaticLiteralRootNode(node)) return;
    const range = readRange(node);
    if (range === undefined) return;
    roots.push({ node, range });
  });
  return roots;
}

function findFirstUserFacingString(root: unknown, source: string): StringCandidate | undefined {
  let found: StringCandidate | undefined;
  walkUnknown(root, (node) => {
    if (found !== undefined) return;
    const text = readAuditableString(node);
    if (text === undefined || !looksUserFacing(text)) return;
    const loc = readStartLocation(node, source);
    if (loc === undefined) return;
    found = { text, loc };
  });
  return found;
}

function readAuditableString(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === "Literal") {
    const value = readProperty(node, "value");
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
  if (node.type === "TemplateLiteral") {
    const quasis = readArrayProperty(node, "quasis") ?? [];
    const text = quasis.map((quasi) => readTemplateElementRaw(quasi)).join("${...}");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function findFirstLikelyVisibleChildText(children: readonly unknown[], source: string | undefined): StringCandidate | undefined {
  for (const child of children) {
    const candidate = findFirstLikelyVisibleTextNode(child, source);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function findFirstLikelyVisibleTextNode(node: unknown, source: string | undefined): StringCandidate | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const type = (node as { type?: unknown }).type;
  if (type === "text") {
    const value = (node as { value?: unknown }).value;
    if (typeof value === "string" && value.trim().length > 0 && looksUserFacing(value)) {
      const loc = readStartLocation(node, source);
      if (loc !== undefined) return { text: value, loc };
    }
  }
  const children = readArrayProperty(node, "children");
  if (children === undefined) return undefined;
  return findFirstLikelyVisibleChildText(children, source);
}

function readTemplateElementRaw(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const value = (node as { value?: { cooked?: unknown; raw?: unknown } }).value;
  if (typeof value?.cooked === "string") return value.cooked;
  if (typeof value?.raw === "string") return value.raw;
  return "";
}

function filterIgnoredFindings(findings: MdxAuditFinding[], source: string | undefined): MdxAuditFinding[] {
  if (source === undefined) return findings;
  const ignoredLines = collectIgnoredLines(source);
  if (ignoredLines.size === 0) return findings;
  return findings.filter((finding) => !ignoredLines.has(finding.line));
}

function collectIgnoredLines(source: string): Set<number> {
  const lines = source.split(/\r?\n/u);
  const ignored = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!hasIgnoreDirective(lines[i] ?? "")) continue;
    let j = i;
    while (j < lines.length && (j === i || (lines[j] ?? "").trim().length > 0)) {
      ignored.add(j + 1);
      j++;
    }
  }
  return ignored;
}

function hasIgnoreDirective(line: string): boolean {
  return /@polystella\s+ignore\b|polystella-ignore\b/.test(line);
}

function sourceSnippet(source: string, range: Range): string {
  const raw = source.slice(range.start, range.end).replace(/\s+/g, " ").trim();
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function rangeKey(range: Range): string {
  return `${range.start}:${range.end}`;
}

function isMdxJsxElement(node: unknown): node is { type: string; name: string } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return (candidate.type === "mdxJsxFlowElement" || candidate.type === "mdxJsxTextElement") && typeof candidate.name === "string";
}

function isMdxJsxAttribute(node: unknown): node is { type: string; name: string; value: unknown } {
  if (typeof node !== "object" || node === null) return false;
  const candidate = node as { type?: unknown; name?: unknown };
  return candidate.type === "mdxJsxAttribute" && typeof candidate.name === "string";
}

function isExpressionAttributeValue(value: unknown): value is { type: string; value: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; value?: unknown };
  return candidate.type === "mdxJsxAttributeValueExpression" && typeof candidate.value === "string";
}

function readStartLocation(node: unknown, source: string | undefined): SourceLocation | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const mdastStart = (node as { position?: { start?: { line?: unknown; column?: unknown } } }).position?.start;
  if (typeof mdastStart?.line === "number" && typeof mdastStart.column === "number") {
    return { line: mdastStart.line, column: mdastStart.column };
  }
  const estreeStart = (node as { loc?: { start?: { line?: unknown; column?: unknown } } }).loc?.start;
  if (typeof estreeStart?.line === "number" && typeof estreeStart.column === "number") {
    return { line: estreeStart.line, column: estreeStart.column + 1 };
  }
  const range = readRange(node);
  if (range !== undefined && source !== undefined) {
    return offsetToLocation(source, range.start);
  }
  return undefined;
}

function offsetToLocation(source: string, offset: number): SourceLocation {
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

function walkUnknown(value: unknown, visitor: (node: unknown) => void): void {
  if (typeof value !== "object" || value === null) return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkUnknown(item, visitor);
    return;
  }
  for (const child of Object.values(value as unknown as Record<string, unknown>)) {
    walkUnknown(child, visitor);
  }
}

function walkWithAncestors(
  value: unknown,
  ancestors: readonly EstreeNode[],
  visitor: (node: EstreeNode, ancestors: readonly EstreeNode[]) => void,
): void {
  if (!isNode(value)) return;
  visitor(value, ancestors);
  const nextAncestors = [...ancestors, value];
  for (const child of Object.values(value as unknown as Record<string, unknown>)) {
    if (Array.isArray(child)) {
      for (const item of child) walkWithAncestors(item, nextAncestors, visitor);
    } else {
      walkWithAncestors(child, nextAncestors, visitor);
    }
  }
}

function isNode(node: unknown): node is EstreeNode {
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

function readIdentifierName(node: unknown): string | undefined {
  if (!isNode(node) || node.type !== "Identifier") return undefined;
  return readStringProperty(node, "name");
}

function readRange(node: unknown): Range | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const start = range[0];
  const end = range[1];
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return { start, end };
}
