import type { Root } from "mdast";

import type { NormalizedMdxRules } from "./mdx-rules.js";

export type MdxAuditSeverity = "low" | "medium" | "high";

export interface MdxAuditFinding {
  sourcePath: string;
  line: number;
  column: number;
  severity: MdxAuditSeverity;
  code: "unconfigured-component-prop" | "unsupported-expression-prop" | "unconfigured-html-attribute";
  text: string;
  message: string;
  suggestion: string;
}

export interface AuditMdxAstOptions {
  sourcePath: string;
  mdxRules: NormalizedMdxRules;
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

export function auditMdxAst(ast: Root, opts: AuditMdxAstOptions): MdxAuditFinding[] {
  const findings: MdxAuditFinding[] = [];
  walkUnknown(ast, (node) => {
    if (!isMdxJsxElement(node)) return;
    const attributes = readArrayProperty(node, "attributes");
    if (attributes === undefined) return;
    for (const attribute of attributes) {
      if (!isMdxJsxAttribute(attribute)) continue;
      const loc = readStartLocation(attribute);
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
  return findings;
}

function buildStaticAttributeFinding(args: {
  sourcePath: string;
  elementName: string;
  attribute: { name: string; value: string };
  loc: { line: number; column: number };
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
      : `Add \`${args.attribute.name}\` to \`markdown.mdx.components.${args.elementName}.props\`, import a recipe, or add an ignore when this is a machine string.`,
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

function readStartLocation(node: unknown): { line: number; column: number } | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const start = (node as { position?: { start?: { line?: unknown; column?: unknown } } }).position?.start;
  if (typeof start?.line !== "number" || typeof start.column !== "number") return undefined;
  return { line: start.line, column: start.column };
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

function readArrayProperty(node: unknown, property: string): unknown[] | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[property];
  return Array.isArray(value) ? value : undefined;
}
