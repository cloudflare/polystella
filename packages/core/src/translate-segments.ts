import { DEFAULT_MAX_PROMPT_TOKENS, estimatePromptTokens, packGroupsIntoBatches } from "./batch.js";
import { formatCorrections, type TranslationCorrection } from "./corrections.js";
import { INLINE_MARKUP_PROMPT_RULE, maskInlineMarkup, restoreInlineMarkup, type MaskedText } from "./inline-markup.js";
import type { Logger } from "./logger.js";
import { runWithConcurrency } from "./pool.js";
import { assertUniqueSegmentIds, type Segment } from "./segment.js";
import { buildBatchPrompt, translateBatch, type TranslateBatchOptions } from "./translate-batch.js";

/** Options for grouping a document's segments into provider requests. */
export interface TranslateSegmentsOptions extends TranslateBatchOptions {
  /** Ordered partition of `segments`; groups are batching hints, not new content. */
  groups?: Segment[][];
  documentContext?: string | undefined;
  inputTokenBudget?: number;
  /**
   * Ceiling for one whole prompt: instructions, matched glossary, document context and segments.
   * A batch over it is split in half until it fits; default `DEFAULT_MAX_PROMPT_TOKENS`.
   */
  maxPromptTokens?: number | undefined;
  logger?: Logger;
  sourcePath?: string;
  /**
   * Batches sent at once; default 1. Raise it only where nothing else runs requests in parallel:
   * the Astro build already translates several files at once.
   */
  concurrency?: number;
}

/** Translation map and number of provider batches used. */
export interface TranslateSegmentsResult {
  translations: Map<string, string>;
  batchCount: number;
}

export async function translateSegments(options: TranslateSegmentsOptions): Promise<TranslateSegmentsResult> {
  const {
    segments,
    groups,
    documentContext,
    inputTokenBudget,
    maxPromptTokens = DEFAULT_MAX_PROMPT_TOKENS,
    logger,
    sourcePath,
    signal,
    concurrency = 1,
    ...rest
  } = options;

  signal?.throwIfAborted();
  assertUniqueSegmentIds(segments.map((segment) => segment.id));
  if (groups !== undefined) {
    const groupedSegments = groups.flat();
    if (groupedSegments.length !== segments.length || groupedSegments.some((segment, index) => segment !== segments[index])) {
      throw new Error("[polystella] translateSegments grouping invariant violated: flat(groups) must equal segments");
    }
  }
  if (segments.length === 0) return { translations: new Map(), batchCount: 0 };

  const masks = new Map<string, MaskedText>();
  const toSend = (segment: Segment): Segment => {
    const masked = segment.markup === undefined ? null : maskInlineMarkup(segment.text, segment.markup);
    if (masked === null) return segment;
    masks.set(segment.id, masked);
    return { id: segment.id, text: masked.text };
  };
  const groupsToUse = (groups ?? [segments]).map((group) => group.map(toSend));
  const packOptions = {
    ...(inputTokenBudget !== undefined ? { inputTokenBudget } : {}),
    ...(logger !== undefined ? { logger } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
  const batches = packGroupsIntoBatches(groupsToUse, packOptions);
  if (batches.length === 0) return { translations: new Map(), batchCount: 0 };
  const promptInstruction = joinInstructions(rest.promptInstruction, masks.size > 0 ? INLINE_MARKUP_PROMPT_RULE : undefined);

  const translations = new Map<string, string>();
  const runBatch = async (batch: Segment[], batchSignal: AbortSignal | undefined, instruction: string | undefined): Promise<void> => {
    batchSignal?.throwIfAborted();
    const batchResult = await translateBatch({
      ...rest,
      segments: batch,
      ...(instruction !== undefined ? { promptInstruction: instruction } : {}),
      ...(documentContext !== undefined ? { documentContext } : {}),
      ...(batchSignal !== undefined ? { signal: batchSignal } : {}),
    });
    for (const [id, text] of batchResult) translations.set(id, text);
  };
  const fitPromptCeiling = (batch: Segment[], instruction: string | undefined): Segment[][] => {
    const prompt = buildBatchPrompt({ ...rest, segments: batch, documentContext, promptInstruction: instruction });
    const tokens = estimatePromptTokens(prompt);
    if (tokens <= maxPromptTokens) return [batch];
    const [only] = batch;
    if (batch.length === 1 && only !== undefined) throw new PromptTooLargeError(only.id, tokens, maxPromptTokens);
    const middle = Math.ceil(batch.length / 2);
    return [...fitPromptCeiling(batch.slice(0, middle), instruction), ...fitPromptCeiling(batch.slice(middle), instruction)];
  };
  /** Runs the batches, split to fit the prompt ceiling first, and returns how many requests that took. */
  const runBatches = async (packed: Segment[][], instruction: string | undefined): Promise<number> => {
    const toRun = packed.flatMap((batch) => fitPromptCeiling(batch, instruction));
    if (concurrency <= 1) {
      for (const batch of toRun) await runBatch(batch, signal, instruction);
      return toRun.length;
    }
    // The first failure cancels batches still in flight instead of paying for answers nobody reads.
    const failed = new AbortController();
    const batchSignal = signal === undefined ? failed.signal : AbortSignal.any([signal, failed.signal]);
    await runWithConcurrency(toRun, concurrency, async (batch) => {
      try {
        await runBatch(batch, batchSignal, instruction);
      } catch (error) {
        if (!failed.signal.aborted) failed.abort(error);
        throw error;
      }
    });
    return toRun.length;
  };

  let batchCount = await runBatches(batches, promptInstruction);
  let corrections = restoreMasked(translations, masks);
  if (corrections.length > 0) {
    // One resend of only the segments whose markup came back wrong, with what was wrong.
    const failedIds = new Set(corrections.map(({ id }) => id));
    const resend = packGroupsIntoBatches([groupsToUse.flat().filter(({ id }) => failedIds.has(id))], packOptions);
    batchCount += await runBatches(resend, joinInstructions(promptInstruction, formatCorrections(corrections)));
    corrections = restoreMasked(translations, new Map([...masks].filter(([id]) => failedIds.has(id))));
    if (corrections.length > 0) throw new InlineMarkupError(corrections);
  }
  return { translations, batchCount };
}

/** One segment's prompt is over `maxPromptTokens` on its own, so splitting can't help. */
export class PromptTooLargeError extends Error {
  constructor(
    readonly segmentId: string,
    readonly estimatedTokens: number,
    readonly maxPromptTokens: number,
  ) {
    super(
      `[polystella] prompt for segment "${segmentId}" is about ${estimatedTokens} tokens, over maxPromptTokens (${maxPromptTokens}). Shorten the glossary's style rules and notes, the context or the text, or raise maxPromptTokens.`,
    );
    this.name = "PromptTooLargeError";
  }
}

/** A translation lost, duplicated or reordered the placeholders standing for its inline markup, twice. */
export class InlineMarkupError extends Error {
  constructor(readonly corrections: readonly TranslationCorrection[]) {
    const [first] = corrections;
    super(
      `[polystella] model changed inline markup in ${corrections.length} segment(s)${first === undefined ? "" : `, first "${first.id}": ${first.problems.join("; ")}`}`,
    );
    this.name = "InlineMarkupError";
  }
}

/** Restores markup in place and returns the segments that failed, leaving their masked answers. */
function restoreMasked(translations: Map<string, string>, masks: ReadonlyMap<string, MaskedText>): TranslationCorrection[] {
  const corrections: TranslationCorrection[] = [];
  for (const [id, masked] of masks) {
    const translation = translations.get(id);
    if (translation === undefined) continue;
    const restored = restoreInlineMarkup(translation, masked);
    if (restored.problems === undefined) translations.set(id, restored.text);
    else corrections.push({ id, translation, problems: restored.problems });
  }
  return corrections;
}

function joinInstructions(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length === 0 ? undefined : present.join("\n\n");
}
