import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownParser {
  parseMarkdown(source: string): Root;
  parseMdx(source: string): Root;
}

const createMarkdownProcessor = () => unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);
const createMdxProcessor = () => createMarkdownProcessor().use(remarkMdx);

export const remarkMarkdownParser: MarkdownParser = {
  parseMarkdown(source) {
    return createMarkdownProcessor().parse(source) as Root;
  },
  parseMdx(source) {
    return createMdxProcessor().parse(source) as Root;
  },
};

export const parseMarkdown = (source: string): Root => remarkMarkdownParser.parseMarkdown(source);
export const parseMdx = (source: string): Root => remarkMarkdownParser.parseMdx(source);
