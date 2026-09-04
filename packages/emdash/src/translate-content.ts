import { translateSegments, type Glossary, type Segment, type Translator } from "@cloudflare/polystella-core";
import { validateTokenPreservation } from "@cloudflare/polystella-core/catalog/translate";

import { MAX_CONTENT_FIELDS } from "./contracts.js";

const MAX_SEGMENTS = 500;
const MAX_SEGMENT_CHARACTERS = 20_000;
const MAX_TOTAL_CHARACTERS = 30_000;

type SegmentTarget = { kind: "field"; field: string } | { kind: "span"; field: string; blockIndex: number; childIndex: number };

type SegmentLocation = SegmentTarget & { leadingWhitespace: string; trailingWhitespace: string };

export class ContentTranslationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentTranslationInputError";
  }
}

export interface TranslateContentFieldsOptions {
  values: Record<string, unknown>;
  translator: Translator;
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  promptInstruction?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface TranslateContentFieldsResult {
  patch: Record<string, unknown>;
  batchCount: number;
}

export async function translateContentFields(options: TranslateContentFieldsOptions): Promise<TranslateContentFieldsResult> {
  const segments: Segment[] = [];
  const groups: Segment[][] = [];
  const locations = new Map<string, SegmentLocation>();
  const fields = Object.entries(options.values);
  if (fields.length > MAX_CONTENT_FIELDS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_CONTENT_FIELDS} fields at once`);
  }

  for (const [fieldIndex, [field, value]] of fields.entries()) {
    const group: Segment[] = [];
    if (typeof value === "string") {
      addSegment(`field:${fieldIndex}`, value, { kind: "field", field }, group, segments, locations);
    } else if (Array.isArray(value)) {
      for (const [blockIndex, block] of value.entries()) {
        if (!isPortableTextNode(block)) {
          throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid block`);
        }
        if (block._type !== "block") continue;
        if (!Array.isArray(block.children)) {
          throw new ContentTranslationInputError(`Portable Text field "${field}" contains a block without children`);
        }
        for (const [childIndex, child] of block.children.entries()) {
          if (!isPortableTextSpan(child)) {
            throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid span`);
          }
          if (block.style === "code") continue;
          addSegment(
            `field:${fieldIndex}:block:${blockIndex}:span:${childIndex}`,
            child.text,
            { kind: "span", field, blockIndex, childIndex },
            group,
            segments,
            locations,
          );
        }
      }
    } else {
      throw new ContentTranslationInputError(`field "${field}" is not supported for translation`);
    }
    if (group.length > 0) groups.push(group);
  }

  if (segments.length > MAX_SEGMENTS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_SEGMENTS} text segments at once`);
  }
  const totalCharacters = segments.reduce((total, segment) => total + segment.text.length, 0);
  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    throw new ContentTranslationInputError(`cannot translate more than ${MAX_TOTAL_CHARACTERS} characters at once`);
  }

  const result = await translateSegments({
    translator: options.translator,
    segments,
    groups,
    glossary: options.glossary,
    sourceLocale: options.sourceLocale,
    targetLocale: options.targetLocale,
    ...(options.promptInstruction === undefined ? {} : { promptInstruction: options.promptInstruction }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const patch = structuredClone(options.values);
  for (const segment of segments) {
    const translation = result.translations.get(segment.id);
    const location = locations.get(segment.id);
    if (translation === undefined || location === undefined) {
      throw new Error(`[polystella-emdash] missing translation for internal segment "${segment.id}"`);
    }
    const tokenIssue = validateTokenPreservation(location.field, segment.text, translation);
    if (tokenIssue !== null) {
      throw new Error(`[polystella-emdash] translation changed placeholder tokens in field "${location.field}"`);
    }
    applyTranslation(patch, location, `${location.leadingWhitespace}${translation}${location.trailingWhitespace}`);
  }
  validatePortableTextTokens(options.values, patch);

  return { patch, batchCount: result.batchCount };
}

function validatePortableTextTokens(source: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue;
    const translated = patch[field];
    if (!Array.isArray(translated)) continue;
    for (const [blockIndex, block] of value.entries()) {
      if (!isRecord(block) || block._type !== "block" || !Array.isArray(block.children)) continue;
      const translatedBlock = translated[blockIndex];
      if (!isRecord(translatedBlock) || !Array.isArray(translatedBlock.children)) continue;
      const sourceText = block.children.map(spanText).join("");
      const translatedText = translatedBlock.children.map(spanText).join("");
      if (validateTokenPreservation(field, sourceText, translatedText) !== null) {
        throw new Error(`[polystella-emdash] translation changed placeholder tokens in field "${field}"`);
      }
    }
  }
}

function spanText(value: unknown): string {
  return isRecord(value) && value._type === "span" && typeof value.text === "string" ? value.text : "";
}

function addSegment(
  id: string,
  source: string,
  target: SegmentTarget,
  group: Segment[],
  segments: Segment[],
  locations: Map<string, SegmentLocation>,
): void {
  const text = source.trim();
  if (text.length === 0) return;
  if (text.length > MAX_SEGMENT_CHARACTERS) {
    throw new ContentTranslationInputError(`one text segment exceeds ${MAX_SEGMENT_CHARACTERS} characters`);
  }
  const start = source.indexOf(text);
  const segment = { id, text };
  group.push(segment);
  segments.push(segment);
  locations.set(id, {
    ...target,
    leadingWhitespace: source.slice(0, start),
    trailingWhitespace: source.slice(start + text.length),
  });
}

function applyTranslation(patch: Record<string, unknown>, location: SegmentLocation, translation: string): void {
  if (location.kind === "field") {
    patch[location.field] = translation;
    return;
  }

  const value = patch[location.field];
  if (!Array.isArray(value)) throw new Error(`[polystella-emdash] Portable Text field "${location.field}" changed shape`);
  const block = value[location.blockIndex];
  if (!isRecord(block) || !Array.isArray(block.children)) {
    throw new Error(`[polystella-emdash] Portable Text field "${location.field}" changed block structure`);
  }
  const child = block.children[location.childIndex];
  if (!isRecord(child) || child._type !== "span") {
    throw new Error(`[polystella-emdash] Portable Text field "${location.field}" changed span structure`);
  }
  child.text = translation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortableTextNode(value: unknown): value is Record<string, unknown> & { _type: string; _key: string } {
  return (
    isRecord(value) && typeof value._type === "string" && value._type.length > 0 && typeof value._key === "string" && value._key.length > 0
  );
}

function isPortableTextSpan(value: unknown): value is Record<string, unknown> & { _type: "span"; _key: string; text: string } {
  return (
    isPortableTextNode(value) &&
    value._type === "span" &&
    typeof value.text === "string" &&
    (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every((mark) => typeof mark === "string")))
  );
}
