import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { Segment } from "../../segment.js";
import { inlineSpan, visitTranslatableBlocks } from "./traverse.js";

/** A Markdown string cut into translatable segments, and how to put translations back in place. */
export interface SplitMarkdownText {
  segments: Segment[];
  /** Rebuilds the string with each segment's text replaced; every segment needs a translation. */
  apply(translations: ReadonlyMap<string, string>): string;
}

/**
 * Splits one Markdown string into paragraph, heading, list-item and table-cell segments, like the Markdown
 * adapter's body, without frontmatter or MDX support, so it stays small enough for a Worker.
 */
export function splitMarkdownText(source: string): SplitMarkdownText {
  const ast = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const spans: Array<{ id: string; start: number; end: number }> = [];
  visitTranslatableBlocks(ast, ({ block, id }) => {
    const span = inlineSpan(block);
    if (span !== undefined && span.end > span.start) spans.push({ id, ...span });
  });
  return {
    segments: spans.map(({ id, start, end }) => ({ id, text: source.slice(start, end), markup: "markdown" })),
    apply(translations) {
      let text = source;
      for (const { id, start, end } of [...spans].sort((a, b) => b.start - a.start)) {
        const translation = translations.get(id);
        if (translation === undefined) throw new Error(`[polystella] missing translation for Markdown segment "${id}"`);
        text = text.slice(0, start) + translation + text.slice(end);
      }
      return text;
    },
  };
}
