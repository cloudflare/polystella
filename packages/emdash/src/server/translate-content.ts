import {
  translateSegments,
  type Glossary,
  type Segment,
  type TranslateBatchAttemptEvent,
  type Translator,
} from "@cloudflare/polystella-core";
import { validateTokenPreservation } from "@cloudflare/polystella-core/catalog/translate";

import { MAX_CONTENT_FIELDS } from "../contracts.js";

const MAX_SEGMENTS = 500;
const MAX_SEGMENT_CHARACTERS = 20_000;
const MAX_TOTAL_CHARACTERS = 30_000;

/** `cell` is `[row, cell]` for spans inside a table block, `null` for a text block's children. */
type SpanContainer = { blockIndex: number; cell: readonly [number, number] | null };

/** Image values keep their media metadata; only these text properties are translated. */
const IMAGE_TEXT_PROPERTIES = ["alt", "caption"] as const;

type SegmentTarget =
  | { kind: "field"; field: string }
  | ({ kind: "span"; field: string; childIndex: number } & SpanContainer)
  | { kind: "item"; field: string; item: number; subField: string; property: (typeof IMAGE_TEXT_PROPERTIES)[number] | null };

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
  onBatchAttempt?: ((event: TranslateBatchAttemptEvent) => void) | undefined;
  onValidationIssue?: ((segmentIds: string[], message: string) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** Repeater field slug → subfields to translate: text values, or an image's alt and caption. Other subfields stay as they are. */
  repeaterSubFields?: Readonly<Record<string, readonly string[]>> | undefined;
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
    const subFields =
      options.repeaterSubFields !== undefined && Object.hasOwn(options.repeaterSubFields, field)
        ? options.repeaterSubFields[field]
        : undefined;
    if (subFields !== undefined) {
      // An emptied optional repeater may be saved as null; it has nothing to translate.
      if (value === null) continue;
      if (!Array.isArray(value)) throw new ContentTranslationInputError(`repeater field "${field}" is not a list`);
      for (const [item, row] of value.entries()) {
        if (!isRecord(row)) throw new ContentTranslationInputError(`repeater field "${field}" contains an invalid item`);
        for (const subField of subFields) {
          const subValue = Object.hasOwn(row, subField) ? row[subField] : undefined;
          const id = `field:${fieldIndex}:item:${item}:${subField}`;
          if (typeof subValue === "string") {
            addSegment(id, subValue, { kind: "item", field, item, subField, property: null }, group, segments, locations);
          } else if (isRecord(subValue)) {
            for (const property of IMAGE_TEXT_PROPERTIES) {
              const text = subValue[property];
              if (typeof text !== "string") continue;
              addSegment(`${id}:${property}`, text, { kind: "item", field, item, subField, property }, group, segments, locations);
            }
          }
        }
      }
    } else if (typeof value === "string") {
      addSegment(`field:${fieldIndex}`, value, { kind: "field", field }, group, segments, locations);
    } else if (Array.isArray(value)) {
      for (const [blockIndex, block] of value.entries()) {
        if (!isPortableTextNode(block)) {
          throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid block`);
        }
        for (const container of spanContainers(field, block, blockIndex)) {
          const spans = containerSpans(value, container);
          if (spans === null) continue;
          for (const [childIndex, child] of spans.entries()) {
            if (!isPortableTextSpan(child)) {
              throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid span`);
            }
            const cellPath = container.cell === null ? "" : `:row:${container.cell[0]}:cell:${container.cell[1]}`;
            addSegment(
              `field:${fieldIndex}:block:${blockIndex}${cellPath}:span:${childIndex}`,
              child.text,
              { kind: "span", field, ...container, childIndex },
              group,
              segments,
              locations,
            );
          }
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
    ...(options.onBatchAttempt === undefined ? {} : { onBatchAttempt: options.onBatchAttempt }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const patch = structuredClone(options.values);
  for (const segment of segments) {
    const translation = result.translations.get(segment.id);
    const location = locations.get(segment.id);
    if (translation === undefined || location === undefined) {
      const message = `[polystella-emdash] missing translation for internal segment "${segment.id}"`;
      notifyValidationIssue(options.onValidationIssue, [segment.id], message);
      throw new Error(message);
    }
    const tokenIssue = validateTokenPreservation(location.field, segment.text, translation);
    if (tokenIssue !== null) {
      const message = `[polystella-emdash] translation changed placeholder tokens in field "${location.field}"`;
      notifyValidationIssue(options.onValidationIssue, [segment.id], message);
      throw new Error(message);
    }
    applyTranslation(patch, location, `${location.leadingWhitespace}${translation}${location.trailingWhitespace}`);
  }
  validatePortableTextTokens(options.values, patch, options.repeaterSubFields ?? {}, (field, container, message) => {
    notifyValidationIssue(
      options.onValidationIssue,
      segments
        .filter((segment) => {
          const location = locations.get(segment.id);
          return location?.kind === "span" && location.field === field && sameContainer(location, container);
        })
        .map(({ id }) => id),
      message,
    );
  });

  return { patch, batchCount: result.batchCount };
}

/** The span lists a block holds: a text block's children, or each table cell's content. Code blocks hold none. */
function spanContainers(field: string, block: Record<string, unknown>, blockIndex: number): SpanContainer[] {
  if (block._type === "block") {
    if (!Array.isArray(block.children)) {
      throw new ContentTranslationInputError(`Portable Text field "${field}" contains a block without children`);
    }
    return block.style === "code" ? [] : [{ blockIndex, cell: null }];
  }
  if (block._type !== "table") return [];
  if (!Array.isArray(block.rows)) throw new ContentTranslationInputError(`Portable Text field "${field}" contains a table without rows`);
  return block.rows.flatMap((row, rowIndex) => {
    if (!isRecord(row) || !Array.isArray(row.cells)) {
      throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid table row`);
    }
    return row.cells.map((cell, cellIndex) => {
      if (!isRecord(cell) || !Array.isArray(cell.content)) {
        throw new ContentTranslationInputError(`Portable Text field "${field}" contains an invalid table cell`);
      }
      return { blockIndex, cell: [rowIndex, cellIndex] as const };
    });
  });
}

function containerSpans(blocks: readonly unknown[], container: SpanContainer): unknown[] | null {
  const block = blocks[container.blockIndex];
  if (!isRecord(block)) return null;
  if (container.cell === null) return Array.isArray(block.children) ? block.children : null;
  const [rowIndex, cellIndex] = container.cell;
  const row = Array.isArray(block.rows) ? block.rows[rowIndex] : undefined;
  const cell = isRecord(row) && Array.isArray(row.cells) ? row.cells[cellIndex] : undefined;
  return isRecord(cell) && Array.isArray(cell.content) ? cell.content : null;
}

function sameContainer(left: SpanContainer, right: SpanContainer): boolean {
  return left.blockIndex === right.blockIndex && left.cell?.[0] === right.cell?.[0] && left.cell?.[1] === right.cell?.[1];
}

function validatePortableTextTokens(
  source: Record<string, unknown>,
  patch: Record<string, unknown>,
  repeaterSubFields: Readonly<Record<string, readonly string[]>>,
  onValidationIssue: (field: string, container: SpanContainer, message: string) => void,
): void {
  for (const [field, value] of Object.entries(source)) {
    if (!Array.isArray(value) || Object.hasOwn(repeaterSubFields, field)) continue;
    const translated = patch[field];
    if (!Array.isArray(translated)) continue;
    for (const [blockIndex, block] of value.entries()) {
      if (!isRecord(block)) continue;
      for (const container of spanContainers(field, block, blockIndex)) {
        const sourceSpans = containerSpans(value, container);
        const translatedSpans = containerSpans(translated, container);
        if (sourceSpans === null || translatedSpans === null) continue;
        if (validateTokenPreservation(field, sourceSpans.map(spanText).join(""), translatedSpans.map(spanText).join("")) !== null) {
          const message = `[polystella-emdash] translation changed placeholder tokens in field "${field}"`;
          onValidationIssue(field, container, message);
          throw new Error(message);
        }
      }
    }
  }
}

function notifyValidationIssue(callback: TranslateContentFieldsOptions["onValidationIssue"], segmentIds: string[], message: string): void {
  try {
    callback?.(segmentIds, message);
  } catch {
    // Diagnostics must not change translation behavior.
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
  if (location.kind === "item") {
    const rows = patch[location.field];
    const row = Array.isArray(rows) ? rows[location.item] : undefined;
    if (!isRecord(row)) throw new Error(`[polystella-emdash] repeater field "${location.field}" changed shape`);
    if (location.property === null) {
      row[location.subField] = translation;
      return;
    }
    const image = row[location.subField];
    if (!isRecord(image)) throw new Error(`[polystella-emdash] repeater field "${location.field}" changed shape`);
    image[location.property] = translation;
    return;
  }

  const value = patch[location.field];
  if (!Array.isArray(value)) throw new Error(`[polystella-emdash] Portable Text field "${location.field}" changed shape`);
  const spans = containerSpans(value, location);
  if (spans === null) {
    throw new Error(`[polystella-emdash] Portable Text field "${location.field}" changed block structure`);
  }
  const child = spans[location.childIndex];
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
