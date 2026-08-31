import type { Segment } from "@cloudflare/polystella-core";
import type { Root } from "mdast";

import type { AdapterApplyOptions, AdapterExtractOptions, FileAdapter } from "../../adapter.js";
import { applyTranslations } from "./apply.js";
import { extractSegments } from "./extract.js";
import type { NormalizedMdxRules } from "./mdx-rules.js";
import type { MarkdownParser } from "./parser.js";
import { remarkMarkdownParser } from "./parser.js";
import { visitTranslatableBlocks } from "./traverse.js";

const MARKDOWN_PROMPT_INSTRUCTION =
  "Preserve markdown formatting markers exactly: **bold**, *italic*, _italic_, `code`, [link text](url). Translate the visible text but never the URL or any code identifier.";

/** Extraction options understood only by the Markdown/MDX adapter. */
export interface MarkdownAdapterExtractOptions extends AdapterExtractOptions {
  mdxRules?: NormalizedMdxRules | undefined;
}

/** Apply options understood only by the Markdown/MDX adapter. */
export interface MarkdownAdapterApplyOptions extends AdapterApplyOptions {
  mdxRules?: NormalizedMdxRules | undefined;
}

export function createMarkdownAdapter(
  parser: MarkdownParser = remarkMarkdownParser,
): FileAdapter<Root, MarkdownAdapterExtractOptions, MarkdownAdapterApplyOptions> {
  return {
    extensions: [".md", ".mdx"],
    promptInstruction: MARKDOWN_PROMPT_INSTRUCTION,

    parse(source, sourcePath) {
      return sourcePath?.toLowerCase().endsWith(".mdx") === true ? parser.parseMdx(source) : parser.parseMarkdown(source);
    },

    extractSegments(parsed, source, options) {
      return extractSegments(
        parsed,
        {
          sourcePath: options.sourcePath,
          frontmatter: options.translatableKeys,
          ...(options.mdxRules !== undefined ? { mdxRules: options.mdxRules } : {}),
        },
        source,
      );
    },

    applyTranslations(parsed, source, translations, options = {}) {
      return applyTranslations(parsed, translations, source, {
        ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
        ...(options.mdxRules !== undefined ? { mdxRules: options.mdxRules } : {}),
        ...(options.topLevelAdditions !== undefined ? { frontmatterAdditions: options.topLevelAdditions } : {}),
      });
    },

    groupSegments(parsed, segments) {
      if (segments.length === 0) return [];
      const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
      const bodyGroups: Segment[][] = [];
      let currentGroup: Segment[] = [];
      visitTranslatableBlocks(parsed, ({ block, id }) => {
        const segment = segmentById.get(id);
        if (segment === undefined) return;
        if (block.type === "heading" && currentGroup.length > 0) {
          bodyGroups.push(currentGroup);
          currentGroup = [];
        }
        currentGroup.push(segment);
      });
      if (currentGroup.length > 0) bodyGroups.push(currentGroup);

      const mdxDataGroup = segments.filter((segment) => !segment.id.startsWith("body:") && !segment.id.startsWith("fm:"));
      const frontmatterGroup = segments.filter((segment) => segment.id.startsWith("fm:"));
      const groups = [...bodyGroups];
      if (mdxDataGroup.length > 0) groups.push(mdxDataGroup);
      if (frontmatterGroup.length > 0) groups.push(frontmatterGroup);
      return groups;
    },
  };
}

export const markdownAdapter = createMarkdownAdapter();
