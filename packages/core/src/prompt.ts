import type { Glossary } from "./glossary.js";
import type { Segment } from "./segment.js";

const MARKER = "@@";
const MARKER_LINE_RE = /^@@([^@\n]+?)@@\s*$/gm;

if (MARKER !== "@@") {
  throw new Error(
    `[polystella] internal invariant violated: MARKER_LINE_RE assumes MARKER === "@@", got ${JSON.stringify(MARKER)}. ` +
      `Update both together.`,
  );
}

/** Inputs needed to build one provider prompt for a segment batch. */
export interface BuildPromptInput {
  segments: Segment[];
  glossary: Glossary;
  sourceLocale: string;
  targetLocale: string;
  context?: string | undefined;
  documentContext?: string | undefined;
  promptInstruction?: string | undefined;
}

/** Provider-ready system and user prompt pair. */
export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const { segments, glossary, sourceLocale, targetLocale, context, documentContext, promptInstruction } = input;
  const sourceName = localeName(sourceLocale);
  const targetName = localeName(targetLocale);

  const systemLines: string[] = [`You are a professional translator.`];
  const trimmedContext = context?.trim();
  if (trimmedContext) {
    systemLines.push(trimmedContext);
  }
  systemLines.push(`Translate from ${sourceName} (${sourceLocale}) to ${targetName} (${targetLocale}).`);
  const trimmedPromptInstruction = promptInstruction?.trim();
  if (trimmedPromptInstruction) systemLines.push("", trimmedPromptInstruction);

  const trimmedDocContext = documentContext?.trim();
  if (trimmedDocContext) {
    systemLines.push("");
    systemLines.push("DOCUMENT CONTEXT (for terminology only; do not translate this block):");
    systemLines.push(trimmedDocContext);
  }

  if (glossary.doNotTranslate.length > 0) {
    systemLines.push("");
    systemLines.push("TERMS THAT MUST NOT BE TRANSLATED (preserve verbatim, including capitalisation):");
    for (const term of glossary.doNotTranslate) {
      systemLines.push(`- ${term}`);
    }
  }

  const preferred = Object.entries(glossary.preferredTranslations);
  if (preferred.length > 0) {
    systemLines.push("");
    systemLines.push("PREFERRED TRANSLATIONS (use these renderings, case-insensitive, when the source term appears):");
    for (const [source, target] of preferred) {
      systemLines.push(`- ${source} -> ${target}`);
    }
  }

  if (glossary.styleRules.length > 0) {
    systemLines.push("");
    systemLines.push("STYLE RULES (apply these throughout):");
    for (const rule of glossary.styleRules) {
      systemLines.push(`- [${rule.category}] ${rule.instruction}`);
      if (rule.example !== undefined) {
        systemLines.push(`  Example: ${rule.example}`);
      }
    }
  }

  const trimmedNotes = glossary.notes.trim();
  if (trimmedNotes.length > 0) {
    systemLines.push("");
    systemLines.push("ADDITIONAL NOTES:");
    systemLines.push(trimmedNotes);
  }

  systemLines.push("");
  systemLines.push("OUTPUT FORMAT:");
  systemLines.push(
    `For each segment in the user message, output a marker line of the form ${MARKER}<segment-id>${MARKER} on its own line, followed by the translated text on subsequent lines. Repeat for every segment id; do not skip any. The set of segment ids in your response MUST equal the set in the user message — do not add, omit, or rename any. Do NOT wrap your output in JSON, code fences, or any other surrounding syntax. Output the markers and translations only.`,
  );

  const userPromptParts: string[] = [
    `Translate the following segments to ${targetName}. Each segment is preceded by a marker line ${MARKER}<segment-id>${MARKER}. Output translations in the SAME format with the SAME segment ids — one marker line per segment, then the translation, then a blank line before the next marker.`,
    "",
  ];
  for (const segment of segments) {
    userPromptParts.push(`${MARKER}${segment.id}${MARKER}`);
    userPromptParts.push(segment.text);
    userPromptParts.push("");
  }

  return {
    systemPrompt: systemLines.join("\n"),
    userPrompt: userPromptParts.join("\n").trimEnd(),
  };
}

export function parseResponse(rawText: string, expectedIds: string[]): Map<string, string> {
  const cleaned = stripCodeFences(rawText.trim());
  const parts = cleaned.split(MARKER_LINE_RE);

  if (parts.length < 3) {
    throw new Error(
      `[polystella] no segment markers in the model response. Expected ${expectedIds.length} markers of the form "${MARKER}<id>${MARKER}". Total length: ${rawText.length} chars.\nRaw response was:\n${truncateRaw(rawText)}`,
    );
  }

  const expected = new Set(expectedIds);
  const result = new Map<string, string>();
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const id = (parts[index] ?? "").trim();
    const value = (parts[index + 1] ?? "").trim();
    if (id.length === 0 || !expected.has(id)) continue;
    if (value.length === 0) {
      throw new Error(`[polystella] model returned an empty translation for segment "${id}"`);
    }
    result.set(id, value);
  }

  for (const id of expectedIds) {
    if (!result.has(id)) {
      const lastEmitted = [...result.keys()].at(-1);
      const totalCharsInResult = [...result.values()].reduce((total, value) => total + value.length, 0);
      const looksTruncated =
        lastEmitted !== undefined && rawText.length > totalCharsInResult && !rawText.includes(`${MARKER}${id}${MARKER}`);
      const hint = looksTruncated
        ? ` Response appears truncated after segment "${lastEmitted}" — the model likely hit its output-token limit. Raise \`provider.maxTokens\` or split the source into smaller files.`
        : "";
      throw new Error(`[polystella] model omitted segment "${id}" from response.${hint}\nRaw response was:\n${truncateRaw(rawText)}`);
    }
  }

  return result;
}

function stripCodeFences(text: string): string {
  if (!text.startsWith("```") || !text.endsWith("```") || text.length < 6) return text;
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return text;
  const closeIndex = text.length - 3;
  if (text.charCodeAt(closeIndex - 1) !== 10 || closeIndex - 1 <= firstNewline) return text;
  return text.slice(firstNewline + 1, closeIndex - 1).trim();
}

function truncateRaw(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const headChars = Math.floor(max / 2);
  const tailChars = max - headChars;
  return `${text.slice(0, headChars)}\n... [truncated middle, total length ${text.length}] ...\n${text.slice(-tailChars)}`;
}

function localeName(code: string): string {
  try {
    return new Intl.DisplayNames(["en-US"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
