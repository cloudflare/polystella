import { ApiResponseError, apiFetch, parseApiResponse } from "@emdash-cms/admin";

import { POLYSTELLA_API_BASE, type TranslationDebugTrace } from "../contracts.js";
import type { SchemaField } from "./types.js";

export async function pluginRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${POLYSTELLA_API_BASE}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  return parseApiResponse<T>(response, "PolyStella request failed");
}

export function errorMessage(value: unknown): string {
  if (value instanceof ApiResponseError && value.status === 403) return "Administrator access is required.";
  return value instanceof Error ? value.message : "An unexpected error occurred.";
}

export function formatErrorDetails(value: unknown): string {
  if (value instanceof ApiResponseError) {
    return [
      `HTTP status: ${value.status}`,
      `Code: ${value.code}`,
      `Message: ${value.message}`,
      ...(value.details === undefined ? [] : [`Details: ${JSON.stringify(value.details, null, 2)}`]),
    ].join("\n");
  }
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return String(value);
}

export function supportsTranslation(field: SchemaField): boolean {
  return field.type === "string" || field.type === "text" || field.type === "portableText";
}

export function isTranslatable(field: SchemaField): boolean {
  return !("translatable" in field) || field.translatable !== false;
}

export function storeTranslationDebug(
  collection: string,
  entryId: string,
  locale: string,
  userId: string,
  trace: TranslationDebugTrace,
): void {
  try {
    sessionStorage.setItem(translationDebugStorageKey(collection, entryId, locale, userId), JSON.stringify(trace));
  } catch {
    // The trace remains available in the current panel when browser storage is unavailable.
  }
}

export function takeTranslationDebug(collection: string, entryId: string, locale: string, userId: string): TranslationDebugTrace | null {
  try {
    const key = translationDebugStorageKey(collection, entryId, locale, userId);
    const stored = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (stored === null) return null;
    const value: unknown = JSON.parse(stored);
    return isTranslationDebugTrace(value) ? value : null;
  } catch {
    return null;
  }
}

export function removeTranslationDebug(collection: string, entryId: string, locale: string, userId: string): void {
  try {
    sessionStorage.removeItem(translationDebugStorageKey(collection, entryId, locale, userId));
  } catch {
    // Browser storage may be unavailable.
  }
}

function translationDebugStorageKey(collection: string, entryId: string, locale: string, userId: string): string {
  return `polystella:debug:${userId}:${collection}:${entryId}:${locale}`;
}

export function isTranslationDebugTrace(value: unknown): value is TranslationDebugTrace {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.operation === "content" || value.operation === "catalog" || value.operation === "sandbox") &&
    (value.provider === "workers-ai-binding" || value.provider === "workers-ai-http") &&
    typeof value.model === "string" &&
    typeof value.maxOutputTokens === "number" &&
    typeof value.inputTokenBudget === "number" &&
    (value.maxSegmentsPerBatch === null || typeof value.maxSegmentsPerBatch === "number") &&
    typeof value.sourceLocale === "string" &&
    typeof value.targetLocale === "string" &&
    typeof value.batchCount === "number" &&
    typeof value.providerCallCount === "number" &&
    typeof value.durationMs === "number" &&
    (value.error === null || typeof value.error === "string") &&
    isStringArray(value.validationIssues) &&
    Array.isArray(value.batches) &&
    value.batches.every(isTranslationDebugBatch)
  );
}

function isTranslationDebugBatch(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.batch === "number" &&
    typeof value.segmentCount === "number" &&
    isStringArray(value.segmentIds) &&
    isStringArray(value.segmentLabels) &&
    typeof value.sourceCharacters === "number" &&
    typeof value.estimatedInputTokens === "number" &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isTranslationDebugAttempt)
  );
}

function isTranslationDebugAttempt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.durationMs === "number" &&
    typeof value.systemPrompt === "string" &&
    typeof value.userPrompt === "string" &&
    (value.response === null || typeof value.response === "string") &&
    (value.translations === null ||
      (isRecord(value.translations) && Object.values(value.translations).every((item) => typeof item === "string"))) &&
    (value.error === null || typeof value.error === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
