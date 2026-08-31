import { packGroupsIntoBatches } from "./batch.js";
import type { Logger } from "./logger.js";
import type { Segment } from "./segment.js";
import { translateBatch, type TranslateBatchOptions } from "./translate-batch.js";

/** Options for grouping a document's segments into provider requests. */
export interface TranslateSegmentsOptions extends TranslateBatchOptions {
  /** Ordered partition of `segments`; groups are batching hints, not new content. */
  groups?: Segment[][];
  documentContext?: string | undefined;
  inputTokenBudget?: number;
  logger?: Logger;
  sourcePath?: string;
}

/** Translation map and number of provider batches used. */
export interface TranslateSegmentsResult {
  translations: Map<string, string>;
  batchCount: number;
}

export async function translateSegments(options: TranslateSegmentsOptions): Promise<TranslateSegmentsResult> {
  const { segments, groups, documentContext, inputTokenBudget, logger, sourcePath, signal, ...rest } = options;

  signal?.throwIfAborted();
  if (segments.length === 0) return { translations: new Map(), batchCount: 0 };

  const groupsToUse = groups ?? [segments];
  const batches = packGroupsIntoBatches(groupsToUse, {
    ...(inputTokenBudget !== undefined ? { inputTokenBudget } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  });
  if (batches.length === 0) return { translations: new Map(), batchCount: 0 };

  const translations = new Map<string, string>();
  for (const batch of batches) {
    signal?.throwIfAborted();
    const batchResult = await translateBatch({
      ...rest,
      segments: batch,
      ...(documentContext !== undefined ? { documentContext } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    for (const [id, text] of batchResult) translations.set(id, text);
  }

  return { translations, batchCount: batches.length };
}
