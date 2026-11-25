import { ApiResponseError, apiFetch, parseApiResponse } from "@emdash-cms/admin";

import { POLYSTELLA_API_BASE, type CollectionPolicy, type TranslationDebugTrace } from "../contracts.js";
import type { SchemaField } from "./types.js";

/** Dispatched on `window` after collection policies are saved, so other tabs can reload them. */
export const COLLECTIONS_SAVED_EVENT = "polystella:collections-saved";

export async function pluginRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${POLYSTELLA_API_BASE}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const value = await parseApiResponse<T>(response, "PolyStella request failed");
  if (isRecord(value) && isRecord(value.localeTags)) rememberLocaleTags(value.localeTags);
  return value;
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

const languageNames = new Intl.DisplayNames(undefined, { type: "language" });
const knownLocaleTags = new Map<string, string>();

/** Keeps the server's `localeTags` so labels name `es-la` as Latin American Spanish, not the code's literal reading. */
export function rememberLocaleTags(tags: Readonly<Record<string, unknown>>): void {
  for (const [locale, tag] of Object.entries(tags)) if (typeof tag === "string") knownLocaleTags.set(locale.toLowerCase(), tag);
}

/** "French (fr)" in the admin's browser language; `code` adds the catalog code when it differs ("French (fr, fr-FR)"). */
export function localeLabel(locale: string, code: string = locale): string {
  const codes = locale.toLowerCase() === code.toLowerCase() ? locale : `${locale}, ${code}`;
  const tag = knownLocaleTags.get(code.toLowerCase()) ?? knownLocaleTags.get(locale.toLowerCase()) ?? code;
  let name: string | undefined;
  try {
    name = languageNames.of(tag);
  } catch {
    // Not a valid BCP 47 tag; show the code alone.
  }
  return name === undefined || name.toLowerCase() === tag.toLowerCase() ? codes : `${name} (${codes})`;
}

export function supportsTranslation(field: SchemaField): boolean {
  return (
    field.type === "string" ||
    field.type === "text" ||
    field.type === "portableText" ||
    field.type === "blocks" ||
    translatableSubFields(field).length > 0
  );
}

/** Enabled in the policy and translatable now; a repeater also needs one of its chosen subfields to still exist. */
export function isPolicyField(field: SchemaField, policy: CollectionPolicy): boolean {
  if (!policy.fields.includes(field.slug) || !supportsTranslation(field) || !isTranslatable(field)) return false;
  if (field.type !== "repeater") return true;
  const chosen = policy.subFields !== undefined && Object.hasOwn(policy.subFields, field.slug) ? policy.subFields[field.slug] : undefined;
  return translatableSubFields(field).some(({ slug }) => chosen?.includes(slug) === true);
}

export interface RepeaterSubField {
  slug: string;
  label: string;
}

const TRANSLATABLE_SUBFIELD_TYPES = new Set(["string", "text", "image"]);

// Slugs that end in these words hold an address or identifier, which a translation would break.
const COPIED_SUBFIELD_ENDINGS = new Set(["url", "uri", "href", "slug", "id", "email", "handle", "username"]);
const COPIED_SUBFIELD_SLUGS = new Set(["link", "author", "author_name"]);

/** The subfields a newly enabled repeater starts with: all but links, ids and author names. */
export function defaultSubFields(field: SchemaField): string[] {
  const snake = (slug: string) =>
    slug
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replaceAll("-", "_");
  return translatableSubFields(field)
    .map(({ slug }) => slug)
    .filter((slug) => {
      const name = snake(slug);
      return !COPIED_SUBFIELD_SLUGS.has(name) && !COPIED_SUBFIELD_ENDINGS.has(name.split("_").at(-1) ?? "");
    });
}

/** A repeater's text and image subfields. EmDash sends `validation.subFields`, though its admin types omit it. */
export function translatableSubFields(field: SchemaField): RepeaterSubField[] {
  if (field.type !== "repeater") return [];
  const validation: unknown = field.validation;
  const subFields = isRecord(validation) && Array.isArray(validation.subFields) ? validation.subFields : [];
  return subFields.flatMap((subField: unknown) =>
    isRecord(subField) &&
    typeof subField.slug === "string" &&
    typeof subField.type === "string" &&
    TRANSLATABLE_SUBFIELD_TYPES.has(subField.type)
      ? [{ slug: subField.slug, label: typeof subField.label === "string" ? subField.label : subField.slug }]
      : [],
  );
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
    (value.glossaryTerms === undefined ||
      (isRecord(value.glossaryTerms) && typeof value.glossaryTerms.sent === "number" && typeof value.glossaryTerms.total === "number")) &&
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
    (value.error === null || typeof value.error === "string") &&
    (value.providerResponse === undefined || isRecord(value.providerResponse))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
