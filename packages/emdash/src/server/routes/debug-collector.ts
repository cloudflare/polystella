import { DEFAULT_INPUT_TOKEN_BUDGET, type TranslateBatchAttemptEvent } from "@cloudflare/polystella-core";

import type { TranslationDebugBatch, TranslationDebugTrace } from "../../contracts.js";
import { publicTranslationFailure } from "./failures.js";

export interface TranslationDebugCollector {
  id: string;
  record(event: TranslateBatchAttemptEvent): void;
  markLastAttemptError(error: unknown): void;
  markValidationIssue(message: string, segmentIds: string[]): void;
  finish(batchCount?: number, error?: string): TranslationDebugTrace;
}

export interface TranslationDebugCollectorOptions {
  operation: TranslationDebugTrace["operation"];
  provider: TranslationDebugTrace["provider"];
  model: string;
  maxOutputTokens: number;
  maxSegmentsPerBatch: number | null;
  sourceLocale: string;
  targetLocale: string;
  labelSegment(id: string): string;
}

export function createTranslationDebugCollector(options: TranslationDebugCollectorOptions): TranslationDebugCollector {
  const startedAt = performance.now();
  const id = crypto.randomUUID();
  const batches: TranslationDebugBatch[] = [];
  const batchesBySegments = new Map<string, TranslationDebugBatch>();
  const validationIssues: string[] = [];

  return {
    id,
    record(event) {
      const key = event.segments.map(({ id }) => id).join("\0");
      let batch = batchesBySegments.get(key);
      if (batch === undefined) {
        batch = {
          batch: batches.length + 1,
          segmentCount: event.segments.length,
          segmentIds: event.segments.map(({ id }) => id),
          segmentLabels: event.segments.map(({ id }) => options.labelSegment(id)),
          sourceCharacters: event.sourceCharacters,
          estimatedInputTokens: event.estimatedInputTokens,
          attempts: [],
        };
        batches.push(batch);
        batchesBySegments.set(key, batch);
      }
      batch.attempts.push({
        attempt: batch.attempts.length + 1,
        durationMs: Math.round(event.durationMs),
        systemPrompt: event.systemPrompt,
        userPrompt: event.userPrompt,
        response: event.response ?? null,
        translations: event.translations === undefined ? null : Object.fromEntries(event.translations),
        error: event.error === undefined ? null : publicTranslationFailure(event.error),
      });
    },
    markLastAttemptError(error) {
      const attempt = batches.at(-1)?.attempts.at(-1);
      if (attempt !== undefined && attempt.error === null) attempt.error = publicTranslationFailure(error);
    },
    markValidationIssue(message, segmentIds) {
      if (!validationIssues.includes(message)) validationIssues.push(message);
      const batch = batches.find((candidate) => segmentIds.some((id) => candidate.segmentIds.includes(id)));
      const attempt = batch?.attempts.at(-1);
      if (attempt !== undefined && attempt.error === null) attempt.error = message;
    },
    finish(batchCount = batches.length, error) {
      return {
        id,
        operation: options.operation,
        provider: options.provider,
        model: options.model,
        maxOutputTokens: options.maxOutputTokens,
        inputTokenBudget: DEFAULT_INPUT_TOKEN_BUDGET,
        maxSegmentsPerBatch: options.maxSegmentsPerBatch,
        sourceLocale: options.sourceLocale,
        targetLocale: options.targetLocale,
        batchCount,
        providerCallCount: batches.reduce((total, batch) => total + batch.attempts.length, 0),
        durationMs: Math.round(performance.now() - startedAt),
        error: error ?? null,
        validationIssues,
        batches,
      };
    },
  };
}

export function contentSegmentLabel(id: string, fields: string[]): string {
  const match = /^field:(\d+)(?::block:(\d+):span:(\d+))?$/.exec(id);
  if (match === null) return id;
  const field = fields[Number(match[1])];
  if (field === undefined) return id;
  return match[2] === undefined ? field : `${field} (block ${match[2]}, span ${match[3]})`;
}

export function catalogSegmentLabel(id: string, entries: ReadonlyArray<{ key: string }>): string {
  const match = /^catalog:(\d+)$/.exec(id);
  return match === null ? id : (entries[Number(match[1])]?.key ?? id);
}
