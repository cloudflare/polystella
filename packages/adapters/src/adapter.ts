import type { Segment } from "@cloudflare/polystella-core";

export interface AdapterExtractOptions {
  sourcePath: string;
  translatableKeys: Record<string, string[]>;
}

export interface AdapterApplyOptions {
  sourcePath?: string | undefined;
  topLevelAdditions?: Record<string, unknown> | undefined;
}

export interface FileAdapter<
  TParsed = unknown,
  TExtractOptions extends AdapterExtractOptions = AdapterExtractOptions,
  TApplyOptions extends AdapterApplyOptions = AdapterApplyOptions,
> {
  readonly extensions: readonly string[];
  /** Format-specific guidance included in model prompts. */
  readonly promptInstruction?: string | undefined;
  parse(source: string, sourcePath?: string | undefined): TParsed;
  extractSegments(parsed: TParsed, source: string, options: TExtractOptions): Segment[];
  applyTranslations(
    parsed: TParsed,
    source: string,
    translations: ReadonlyMap<string, string>,
    options?: TApplyOptions | undefined,
  ): string;
  groupSegments?: ((parsed: TParsed, segments: Segment[]) => Segment[][]) | undefined;
}
