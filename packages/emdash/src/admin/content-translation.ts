import { createContent, fetchContent, updateContent } from "@emdash-cms/admin";

import type { TranslateContentResponse, TranslationDebugTrace } from "../contracts.js";
import { pluginRequest } from "./utils.js";

type ContentItem = Awaited<ReturnType<typeof fetchContent>>;

export interface ContentTranslationHooks {
  onTranslating?: (() => void) | undefined;
  /** Runs before the save, so a trace stays visible even when the save fails. */
  onTranslated?: ((debug: TranslationDebugTrace | undefined) => void) | undefined;
}

export type ContentTranslationResult =
  { entry: ContentItem; debug?: TranslationDebugTrace | undefined } | { entry: null; error: string; debug: TranslationDebugTrace };

export interface TranslateExistingEntryInput extends ContentTranslationHooks {
  collection: string;
  entryId: string;
  locale: string;
  fields: readonly string[];
}

/** Replaces the selected fields of a saved translation. `_rev` makes EmDash reject the save if the entry changed meanwhile. */
export async function translateExistingEntry(input: TranslateExistingEntryInput): Promise<ContentTranslationResult> {
  const { collection, entryId, locale } = input;
  const saved = await fetchContent(collection, entryId, { locale });
  if (saved._rev === undefined) throw new Error("EmDash did not return a revision token; no fields were changed.");
  const result = await requestTranslation(input, entryId, locale);
  if (result.patch === null) return { entry: null, error: result.error, debug: result.debug };
  const entry = await updateContent(collection, entryId, { data: result.patch, _rev: saved._rev }, { locale });
  return { entry, debug: result.debug };
}

export interface CreateTranslatedEntryInput extends ContentTranslationHooks {
  collection: string;
  sourceEntryId: string;
  sourceLocale: string | undefined;
  locale: string;
  fields: readonly string[];
}

/** Creates a draft in `locale` from the latest saved source entry, with the selected fields translated. */
export async function createTranslatedEntry(input: CreateTranslatedEntryInput): Promise<ContentTranslationResult> {
  const { collection, sourceEntryId, locale } = input;
  const source = await fetchContent(collection, sourceEntryId, input.sourceLocale === undefined ? {} : { locale: input.sourceLocale });
  const result = await requestTranslation(input, sourceEntryId, locale);
  if (result.patch === null) return { entry: null, error: result.error, debug: result.debug };
  // Same payload as EmDash's own "Create translation" button, with the selected fields translated.
  const entry = await createContent(collection, {
    data: { ...source.data, ...result.patch },
    slug: source.slug,
    locale,
    translationOf: sourceEntryId,
  });
  return { entry, debug: result.debug };
}

async function requestTranslation(
  input: ContentTranslationHooks & { collection: string; fields: readonly string[] },
  entryId: string,
  targetLocale: string,
): Promise<TranslateContentResponse> {
  input.onTranslating?.();
  const result = await pluginRequest<TranslateContentResponse>("translate-content", {
    method: "POST",
    body: JSON.stringify({ collection: input.collection, entryId, targetLocale, fields: input.fields }),
  });
  input.onTranslated?.(result.debug);
  return result;
}
