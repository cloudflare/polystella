import type { Segment } from "@cloudflare/polystella-core";

import type { NormalizedMdxRules } from "./mdx-rules.js";

export interface AdapterExtractOptions {
  sourcePath: string;
  translatableKeys: Record<string, string[]>;
  mdxRules?: NormalizedMdxRules | undefined;
}

export interface AdapterApplyOptions {
  sourcePath?: string | undefined;
  mdxRules?: NormalizedMdxRules | undefined;
  topLevelAdditions?: Record<string, unknown> | undefined;
}

export interface FileAdapter<TParsed = unknown> {
  readonly extensions: readonly string[];
  /** Format-specific guidance included in model prompts. */
  readonly promptInstruction?: string | undefined;
  parse(source: string, sourcePath?: string | undefined): TParsed;
  extractSegments(parsed: TParsed, source: string, options: AdapterExtractOptions): Segment[];
  applyTranslations(
    parsed: TParsed,
    source: string,
    translations: ReadonlyMap<string, string>,
    options?: AdapterApplyOptions | undefined,
  ): string;
  groupSegments?: ((parsed: TParsed, segments: Segment[]) => Segment[][]) | undefined;
}
