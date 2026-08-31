import {
  createMarkdownAdapter,
  resolveFrontmatterKeys,
  type MarkdownAdapterApplyOptions as AdapterApplyOptions,
  type MarkdownAdapterExtractOptions as AdapterExtractOptions,
} from "@cloudflare/polystella-adapters";
import type { Segment } from "@cloudflare/polystella-core";
import type { Root, Yaml } from "mdast";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { AdapterDocumentContextOptions, AdapterParseOptions, AdapterRewriteUrlsOptions, FileTypeAdapter } from "../adapter.js";
import { parseMarkdown, resolveMarkdownParser } from "../parse.js";

const portableMarkdownAdapter = createMarkdownAdapter();

export const markdownAdapter: FileTypeAdapter<Root> = {
  extensions: portableMarkdownAdapter.extensions,
  ...(portableMarkdownAdapter.promptInstruction !== undefined ? { promptInstruction: portableMarkdownAdapter.promptInstruction } : {}),

  parse(source: string, sourcePath?: string, options: AdapterParseOptions = {}): Root {
    return createMarkdownAdapter(resolveMarkdownParser(options.markdownParser)).parse(source, sourcePath);
  },

  extractSegments(parsed: Root, source: string, options: AdapterExtractOptions): Segment[] {
    return portableMarkdownAdapter.extractSegments(parsed, source, options);
  },

  applyTranslations(parsed: Root, source: string, translations: Map<string, string>, options: AdapterApplyOptions): string {
    return portableMarkdownAdapter.applyTranslations(parsed, source, translations, options);
  },

  selectedValuesForHash(parsed: Root, _source: string, options: AdapterExtractOptions): Record<string, unknown> {
    const frontmatter = readFrontmatter(parsed);
    const selected: Record<string, unknown> = {};
    for (const key of resolveFrontmatterKeys(options.sourcePath, options.translatableKeys)) {
      if (Object.hasOwn(frontmatter, key)) selected[key] = frontmatter[key];
    }
    return selected;
  },

  peekNoTranslate(parsed: Root): boolean {
    const value = readFrontmatter(parsed).noTranslate;
    if (value === true) return true;
    return typeof value === "string" && ["true", "yes"].includes(value.toLowerCase().trim());
  },

  rewriteUrls(bytes: string, options: AdapterRewriteUrlsOptions): string {
    if (options.paths.length === 0) return bytes;
    const ast = parseMarkdown(bytes, { parser: options.markdownParser });
    const frontmatterNode = ast.children.find((child): child is Yaml => child.type === "yaml");
    const start = frontmatterNode?.position?.start?.offset;
    const end = frontmatterNode?.position?.end?.offset;
    if (frontmatterNode === undefined || typeof start !== "number" || typeof end !== "number") return bytes;

    const frontmatter = parseYaml(frontmatterNode.value) as Record<string, unknown>;
    let changed = false;
    for (const key of options.paths) {
      const value = frontmatter[key];
      if (typeof value !== "string") continue;
      const rewritten = options.rewriter(value);
      if (rewritten === null || rewritten === value) continue;
      frontmatter[key] = rewritten;
      changed = true;
    }
    if (!changed) return bytes;
    const inner = stringifyYaml(frontmatter).replace(/\n+$/, "");
    return `${bytes.slice(0, start)}---\n${inner}\n---${bytes.slice(end)}`;
  },

  groupSegments(parsed: Root, segments: Segment[]): Segment[][] {
    return portableMarkdownAdapter.groupSegments?.(parsed, segments) ?? [segments];
  },

  documentContext(parsed: Root, options: AdapterDocumentContextOptions): string | undefined {
    const frontmatter = readFrontmatter(parsed);
    const lines: string[] = [];
    for (const key of resolveFrontmatterKeys(options.sourcePath, options.contextKeys)) {
      const value = frontmatter[key];
      if (typeof value !== "string") continue;
      const flattened = value.replace(/\s*\n\s*/g, " ").trim();
      if (flattened.length > 0) lines.push(`${titleCaseKey(key)}: ${flattened}`);
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
  },
};

function readFrontmatter(parsed: Root): Record<string, unknown> {
  const node = parsed.children.find((child): child is Yaml => child.type === "yaml");
  if (node === undefined) return {};
  try {
    const value = parseYaml(node.value);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function titleCaseKey(key: string): string {
  return key
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
