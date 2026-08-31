import type { Logger } from "./logger.js";
import type { Segment } from "./segment.js";

export const DEFAULT_INPUT_TOKEN_BUDGET = 4000;

const TOKEN_CHAR_RATIO = 4;
const SEGMENT_OVERHEAD_CHARS = 8;

export function estimateInputTokens(segments: Segment[]): number {
  if (segments.length === 0) return 0;
  let chars = 0;
  for (const segment of segments) {
    chars += segment.id.length + segment.text.length + SEGMENT_OVERHEAD_CHARS;
  }
  return Math.ceil(chars / TOKEN_CHAR_RATIO);
}

/** Token budget and diagnostics used when packing groups into batches. */
export interface PackGroupsIntoBatchesOptions {
  inputTokenBudget?: number;
  logger?: Logger;
  sourcePath?: string;
}

export function packGroupsIntoBatches(groups: Segment[][], options: PackGroupsIntoBatchesOptions = {}): Segment[][] {
  const budget = options.inputTokenBudget ?? DEFAULT_INPUT_TOKEN_BUDGET;
  const batches: Segment[][] = [];
  let currentBatch: Segment[] = [];
  let currentTokens = 0;

  const flushCurrent = (): void => {
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
  };

  for (const group of groups) {
    if (group.length === 0) continue;
    const groupTokens = estimateInputTokens(group);

    if (groupTokens > budget) {
      flushCurrent();
      options.logger?.warn(
        `[polystella] section in ${options.sourcePath ?? "<unknown>"} exceeds batch input-token budget (${groupTokens} > ${budget}); splitting paragraph-by-paragraph — heading anchor is lost for sub-batches past the first`,
      );
      for (const segment of group) {
        const segmentTokens = estimateInputTokens([segment]);
        if (currentTokens + segmentTokens <= budget) {
          currentBatch.push(segment);
          currentTokens += segmentTokens;
        } else {
          flushCurrent();
          currentBatch.push(segment);
          currentTokens = segmentTokens;
        }
      }
      continue;
    }

    if (currentTokens + groupTokens > budget) flushCurrent();
    currentBatch.push(...group);
    currentTokens += groupTokens;
  }

  flushCurrent();
  return batches;
}
