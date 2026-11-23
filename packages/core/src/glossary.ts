/** Categorized prose instruction applied throughout a translation. */
export interface StyleRule {
  category: string;
  instruction: string;
  example?: string;
}

/** Locale-specific terminology and style constraints supplied to the model. */
export interface Glossary {
  version: string;
  doNotTranslate: string[];
  preferredTranslations: Record<string, string>;
  styleRules: StyleRule[];
  notes: string;
}

export const EMPTY_GLOSSARY: Glossary = {
  version: "",
  doNotTranslate: [],
  preferredTranslations: {},
  styleRules: [],
  notes: "",
};

export interface GlossaryMatchOptions {
  /** Let any letters follow a term, so `Access` also matches "Accessibility". Default: the term must end at a word boundary. */
  matchInflections?: boolean | undefined;
}

/** What a batch's prompt carried, for debug traces. */
export interface GlossaryStats {
  totalTerms: number;
  sentTerms: number;
  /** Characters of the terms (and their translations) sent. */
  sentCharacters: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Keeps only the `doNotTranslate` terms and `preferredTranslations` whose source term appears in `text`,
 * case-insensitively and starting at a word boundary. Style rules and notes aren't term-bound, so they always stay.
 */
export function selectGlossaryForText(
  glossary: Glossary,
  text: string,
  options: GlossaryMatchOptions = {},
): { glossary: Glossary; stats: GlossaryStats } {
  const haystack = normalizeForMatching(text);
  const appears = (term: string): boolean => termAppears(haystack, normalizeForMatching(term), options.matchInflections === true);
  const doNotTranslate = glossary.doNotTranslate.filter(appears);
  const preferred = Object.entries(glossary.preferredTranslations).filter(([source]) => appears(source));
  const sentCharacters =
    doNotTranslate.reduce((total, term) => total + term.length, 0) +
    preferred.reduce((total, [source, target]) => total + source.length + target.length, 0);
  return {
    glossary: { ...glossary, doNotTranslate, preferredTranslations: Object.fromEntries(preferred) },
    stats: {
      totalTerms: glossary.doNotTranslate.length + Object.keys(glossary.preferredTranslations).length,
      sentTerms: doNotTranslate.length + preferred.length,
      sentCharacters,
    },
  };
}

function normalizeForMatching(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

// shortcut: CJK and Thai have no spaces, so a term next to another word still counts as bounded only by non-letters; add script-aware boundaries if a non-English source needs them.
function termAppears(haystack: string, term: string, matchInflections: boolean): boolean {
  if (term.trim().length === 0) return false;
  // A term edge that isn't a letter or digit, like ".NET" or "C++", is its own boundary.
  const checkStart = WORD_CHARACTER.test(term.charAt(0));
  const checkEnd = !matchInflections && WORD_CHARACTER.test(term.charAt(term.length - 1));
  for (let index = haystack.indexOf(term); index !== -1; index = haystack.indexOf(term, index + 1)) {
    if (checkStart && WORD_CHARACTER.test(haystack.charAt(index - 1))) continue;
    if (checkEnd && WORD_CHARACTER.test(haystack.charAt(index + term.length))) continue;
    return true;
  }
  return false;
}
