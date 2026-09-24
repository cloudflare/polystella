import { TERMINOLOGY_MAP } from './terminology';
import { DO_NOT_TRANSLATE_TERMS } from '../locales/utils';
import { readFileSync } from 'node:fs';

type UserInputParams = {
  text: string;
  /**
   * BCP-47 source locale code (e.g. "en-US", "ja-JP"). Required — the
   * handler in `api/src/index.ts` resolves an omitted request field to
   * "en-US" before calling this. Required at the type level (no default
   * here) so a grep for `sourceLocale:` shows every call site's choice,
   * mirroring the `guardrailMode` convention.
   */
  sourceLocale: string;
  targetLocale: string;
};

export const buildUserInput = ({
  text,
  sourceLocale,
  targetLocale
}: UserInputParams) => {
  const isJSON = text.trim().startsWith('{') || text.trim().startsWith('[');

  if (isJSON) {
    return `
      Translate this JSON from ${sourceLocale} to ${targetLocale}.
    
      ⚠️ CRITICAL REQUIREMENTS:
      - Keep ALL ${Object.keys(JSON.parse(text)).length} keys exactly as they are (untranslated)
      - Translate ONLY the string values
      - Maintain the exact same order
      - Return complete valid JSON with every single key
      - Output MUST be parseable by JSON.parse()
      - Output MUST start with { or [ (no prefix text)
      - Output MUST end with } or ] (no suffix text)
      - Properly escape all special characters in translated strings (quotes, newlines, backslashes, etc.)

      Input JSON:
      ${text}

      Expected output: Valid JSON object/array with translated values ONLY (no explanatory text)
    `;
  }

  return `Translate this text from ${sourceLocale} to ${targetLocale}. Return ONLY the translated text, no other text:\n\n${text}`;
};

/**
 * Context about why this attempt is a retry, used to shape the system
 * prompt. Optional — absent on first attempts
 */
export interface RetryContext {
  /**
   * Which failure class drove the retry. Only `content_guardrail` currently
   * adjusts the prompt.
   */
  reason: 'placeholder' | 'content_guardrail';
  previousFailureCount: number;
}

/**
 * Reinforcement instructions appended to the system prompt when a prior
 * attempt tripped the content guardrail.
 */
export const GUARDRAIL_RETRY_REINFORCEMENT = {
  tier1:
    'IMPORTANT: A previous translation attempt was rejected because it contained inappropriate language for this locale. Translate using neutral, formal register only. Do not use crude, offensive, or unprofessional words. When uncertain, prefer the most formal and conservative equivalent.',
  tier2:
    'Additionally: Translate literally and conservatively. Avoid idiomatic expressions entirely.'
} as const;

type SystemContextParams = {
  /**
   * BCP-47 source locale code (e.g. "en-US", "ja-JP"). Required — the
   * handler resolves an omitted request field to "en-US" before this is
   * called. Drives the "translating from X to Y" wording in the system
   * prompt and gates terminology-glossary injection (skipped when the
   * source isn't English because glossary keys are English strings).
   */
  sourceLocale: string;
  targetLocale: string;
  sourceText: string;
  retryContext?: RetryContext;
};

const ALWAYS_INCLUDE_GLOSSARY_TERMS = new Set(
  [
    'Cloudflare',
    'API endpoints',
    'DDoS attack',
    'DNS',
    'Firewall',
    'Load Balancing',
    'Cache',
    'SSL/TLS'
  ].map((term) => term.toLowerCase())
);

/** Metadata about what resources were available when building the prompt */
export interface PromptBuildMeta {
  /** Whether a terminology glossary was found for this locale */
  hasTerminology: boolean;
  /** Number of terminology entries injected */
  terminologyEntryCount: number;
  /** Which style guide file was loaded, or null if none */
  styleGuideSource: string | null;
}

interface TerminologyResult {
  section: string;
  hasTerminology: boolean;
  entryCount: number;
}

const collectStringValues = (value: unknown, output: string[]): void => {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === 'string') {
      output.push(current);
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push(current[index]);
      }
      continue;
    }

    if (typeof current === 'object' && current !== null) {
      const values = Object.values(current as Record<string, unknown>);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        pending.push(values[index]);
      }
    }
  }
};

const buildTerminologySearchCorpus = (sourceText: string): string => {
  try {
    const parsed = JSON.parse(sourceText);
    const collected: string[] = [];
    collectStringValues(parsed, collected);
    return collected.join('\n').toLowerCase();
  } catch {
    return sourceText.toLowerCase();
  }
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const termPatternCache = new Map<string, RegExp>();

const getTermPattern = (normalizedTerm: string): RegExp => {
  let pattern = termPatternCache.get(normalizedTerm);
  if (!pattern) {
    pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}($|[^a-z0-9])`
    );
    termPatternCache.set(normalizedTerm, pattern);
  }
  return pattern;
};

const containsTerm = (searchCorpus: string, term: string): boolean => {
  const normalizedTerm = term.trim().toLowerCase();
  if (!normalizedTerm) {
    return false;
  }

  if (!/[a-z0-9]/.test(normalizedTerm)) {
    return searchCorpus.includes(normalizedTerm);
  }

  return getTermPattern(normalizedTerm).test(searchCorpus);
};

const getTerminologyVariants = (termKey: string): string[] => {
  return termKey
    .split(';')
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
};

const selectRelevantTerminology = (
  searchCorpus: string,
  terminology: Record<string, string>
): Record<string, string> => {
  const selected: Record<string, string> = {};

  for (const [termKey, translation] of Object.entries(terminology)) {
    const variants = getTerminologyVariants(termKey);
    const shouldAlwaysInclude = variants.some((variant) =>
      ALWAYS_INCLUDE_GLOSSARY_TERMS.has(variant.toLowerCase())
    );
    const appearsInSource = variants.some((variant) =>
      containsTerm(searchCorpus, variant)
    );

    if (shouldAlwaysInclude || appearsInSource) {
      selected[termKey] = translation;
    }
  }

  return selected;
};

const selectRelevantDoNotTranslateTerms = (searchCorpus: string): string[] => {
  return DO_NOT_TRANSLATE_TERMS.filter((term) =>
    containsTerm(searchCorpus, term)
  );
};

/**
 * Locales whose source corpus we treat as English-keyed terminology
 * compatible. Currently only `en-US`. Adding `en-GB`, `en-AU`, etc.
 * to `VALID_LOCALES` does NOT automatically enable terminology
 * injection for those variants — explicitly add them here so the
 * decision is intentional rather than inherited via prefix-matching.
 *
 * (Per UI-8255 review: prefer exact-set membership over
 * `startsWith('en')` to avoid silent drift.)
 */
const ENGLISH_SOURCE_LOCALES = new Set(['en-US']);

/**
 * Returns true when sourceLocale is one we treat as English-keyed.
 *
 * Glossaries in this project are keyed in English, so terminology lookup
 * against a non-English source corpus is guaranteed to miss every entry.
 * We short-circuit when the source isn't English so `meta.hasTerminology`
 * is honestly `false` (observable on the locale span as
 * `has_terminology: false`).
 */
const isEnglishSource = (sourceLocale: string): boolean =>
  ENGLISH_SOURCE_LOCALES.has(sourceLocale);

const getTerminologyPromptSection = (
  sourceLocale: string,
  targetLocale: string,
  searchCorpus: string
): TerminologyResult => {
  // Glossary keys are English. Skip entirely for non-English source so we
  // don't waste prompt tokens scanning a corpus that can never match.
  if (!isEnglishSource(sourceLocale)) {
    return { section: '', hasTerminology: false, entryCount: 0 };
  }

  const terminology = TERMINOLOGY_MAP[targetLocale] || {};
  const selectedTerminology = selectRelevantTerminology(
    searchCorpus,
    terminology
  );
  const entryCount = Object.keys(selectedTerminology).length;

  const section =
    entryCount > 0
      ? `\n\nTERMINOLOGY REFERENCE:
        When translating, use these EXACT term mappings for consistency:
        - The keys are English terms/phrases that may appear in the source text
        - The values are the approved ${targetLocale} translations
        - When you encounter any of these English terms, use the corresponding translation exactly as provided
        - These translations take priority over your own interpretation

        ${JSON.stringify(selectedTerminology, null, 2)}`
      : '';

  return { section, hasTerminology: entryCount > 0, entryCount };
};

interface StyleGuideResult {
  section: string;
  source: string | null;
}

const getStyleGuidePromptSection = (targetLocale: string): StyleGuideResult => {
  const styleGuidePath = `/bundle/locales/language-guide-new/${targetLocale}.md`;
  const defaultStyleGuidePath = `/bundle/locales/language-guide-new/default.md`;

  const paths = [styleGuidePath, defaultStyleGuidePath];
  let styleGuideContent: string | null = null;
  let loadedPath: string | null = null;

  for (const path of paths) {
    try {
      styleGuideContent = readFileSync(path, 'utf-8');
      loadedPath = path;
      break;
    } catch {
      continue;
    }
  }

  if (!styleGuideContent) {
    return { section: '', source: null };
  }

  const source = loadedPath?.includes(targetLocale)
    ? `${targetLocale}.md`
    : 'default.md';

  return {
    source,
    section: `\n\nLANGUAGE STYLE GUIDE:
        You MUST follow this comprehensive style guide for ${targetLocale}:
        
        ${styleGuideContent}
        
        This style guide takes precedence over general translation practices. Pay special attention to:
        - Brand voice and tone requirements
        - Grammar and style conventions
        - Punctuation rules specific to ${targetLocale}
        - Formatting and typography standards
        - Technical localization guidelines`
  };
};

/**
 * Builds the retry-reinforcement block to append to the system prompt when
 * a prior attempt tripped the content guardrail. Returns empty string when
 * no reinforcement applies (first attempt, placeholder retry, or no
 * retryContext provided).
 */
const getGuardrailRetrySection = (
  retryContext: RetryContext | undefined
): string => {
  if (!retryContext) return '';
  if (retryContext.reason !== 'content_guardrail') return '';

  // Tier 1 always fires on a content_guardrail retry. Tier 2 stacks on top
  // when any key has been flagged twice or more in this locale.
  const tier2 =
    retryContext.previousFailureCount >= 2
      ? `\n        ${GUARDRAIL_RETRY_REINFORCEMENT.tier2}`
      : '';

  return `\n\n    ## CONTENT GUARDRAIL RETRY REINFORCEMENT
        ${GUARDRAIL_RETRY_REINFORCEMENT.tier1}${tier2}`;
};

export const buildSystemContext = ({
  sourceLocale,
  targetLocale,
  sourceText,
  retryContext
}: SystemContextParams): { prompt: string; meta: PromptBuildMeta } => {
  const searchCorpus = buildTerminologySearchCorpus(sourceText);
  const terminology = getTerminologyPromptSection(
    sourceLocale,
    targetLocale,
    searchCorpus
  );
  // Decision (UI-8255): keep do-not-translate injection running for ALL
  // source locales. Product names like "Cloudflare", "Workers", "R2" are
  // typically written in English even in non-English source text (e.g. a
  // French support ticket about "Cloudflare Workers" uses those exact
  // words). The boundary regex `[a-z0-9]` works for Latin-script source
  // corpora; CJK/Arabic edge cases are documented and addressed only if
  // Support reports issues.
  const doNotTranslateTerms = selectRelevantDoNotTranslateTerms(searchCorpus);
  const styleGuide = getStyleGuidePromptSection(targetLocale);
  const guardrailRetrySection = getGuardrailRetrySection(retryContext);

  const doNotTranslatePromptLine =
    doNotTranslateTerms.length > 0
      ? `- Product names in source: ${JSON.stringify(doNotTranslateTerms)}`
      : '';

  const prompt = `You are a professional technical translator for Cloudflare translating from ${sourceLocale} to ${targetLocale}.

    ⚠️ CRITICAL OUTPUT RULES ⚠️
    1. Return ONLY the translated content - NO explanations, reasoning, or commentary
    2. DO NOT add prefixes like "Here is the translation:" or suffixes
    3. Your entire response must be ONLY the translation
    
    ## JSON HANDLING (when input is JSON):
    - Output MUST be valid JSON parseable by JSON.parse()
    - Output MUST start with { or [ and end with } or ]
    - Include ALL keys from input in the same order
    - Keep key names EXACTLY as they are (untranslated)
    - ONLY translate the string values
    - Properly escape special characters: \" for quotes, \\n for newlines, \\\\ for backslashes
    - Use double quotes for strings, NO trailing commas, NO comments
    
    ## PRESERVE EXACTLY (do not translate):
    - JSON keys
    - Template variables: %{name}, {{variable}}
    - Component placeholders: <0></0>, <1></1>
    - HTML tags: <script>, <textarea>, etc.
    - URLs and code examples
    - Markdown formatting: ####, **, \`\`
    
    ${doNotTranslatePromptLine}

    ${terminology.section}

    ${styleGuide.section}${guardrailRetrySection}
    `;

  return {
    prompt,
    meta: {
      hasTerminology: terminology.hasTerminology,
      terminologyEntryCount: terminology.entryCount,
      styleGuideSource: styleGuide.source
    }
  };
};

export function generateJsonSchema(jsonString: string): {
  type: string;
  properties: Record<string, { type: string }>;
} {
  const parsedJson: unknown = JSON.parse(jsonString);
  const schema: {
    type: string;
    properties: Record<string, { type: string }>;
    required: string[];
  } = {
    type: 'object',
    properties: {},
    required: []
  };

  function recursiveGenerateSchema(obj: Record<string, unknown>) {
    for (const key of Object.keys(obj)) {
      schema.properties[key] = { type: 'string' };
      schema.required.push(key);
      const value = obj[key];
      if (typeof value === 'object' && value !== null) {
        recursiveGenerateSchema(value as Record<string, unknown>);
      }
    }
  }

  if (typeof parsedJson === 'object' && parsedJson !== null) {
    recursiveGenerateSchema(parsedJson as Record<string, unknown>);
  }

  return schema;
}
