export const MDX_RULES_VERSION = "mdx-rules-v1";

export interface NormalizedMdxComponentRule {
  children?: boolean | undefined;
  props: string[];
}

export interface NormalizedMdxRules {
  version: typeof MDX_RULES_VERSION;
  htmlAttributes: Record<string, string[]>;
  components: Record<string, NormalizedMdxComponentRule>;
  data: Record<string, Record<string, string[]>>;
}
