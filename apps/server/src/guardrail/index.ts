/**
 * Pure static-analysis profanity check applied to translated output.
 *
 * Scope: the 9 Stratus-consumed locales. Any other locale receives a no-op
 * pass with `skipped: true` and `skipReason: 'locale_out_of_scope'` so the
 * gap is observable rather than silent.
 *
 * Data source: the `naughty-words` npm package (LDNOOBW, CC-BY-4.0).
 */
import {
  GUARDRAIL_SUPPORTED_LOCALES,
  type GuardrailSupportedLocale
} from '../locales';

// Re-export so existing consumers that imported these symbols from
// './guardrail' keep working. `../locales` is the source of truth for the
// supported-locale list; this module is where that list gets bound to
// wordlist and allowlist data.
export { GUARDRAIL_SUPPORTED_LOCALES, type GuardrailSupportedLocale };

// Static wordlist imports — per-locale JSON arrays from the naughty-words package.
import deWords from 'naughty-words/de.json';
import esWords from 'naughty-words/es.json';
import frWords from 'naughty-words/fr.json';
import itWords from 'naughty-words/it.json';
import jaWords from 'naughty-words/ja.json';
import koWords from 'naughty-words/ko.json';
import ptWords from 'naughty-words/pt.json';
import zhWords from 'naughty-words/zh.json';

// Allowlist imports — one global, one per supported locale.
// global and per local allowlist are merged into one list at module load
import globalAllowlist from './allowlist/global.json';
import deDEAllow from './allowlist/de-DE.json';
import esESAllow from './allowlist/es-ES.json';
import frFRAllow from './allowlist/fr-FR.json';
import itITAllow from './allowlist/it-IT.json';
import jaJPAllow from './allowlist/ja-JP.json';
import koKRAllow from './allowlist/ko-KR.json';
import ptBRAllow from './allowlist/pt-BR.json';
import zhCNAllow from './allowlist/zh-CN.json';
import zhTWAllow from './allowlist/zh-TW.json';

/**
 * Per-locale guardrail configuration: raw wordlist data, per-locale
 * allowlist data, and the matching algorithm discriminator.
 *
 *   - `wordlist`: LDNOOBW data imported from the `naughty-words` package.
 *     zh-CN and zh-TW deliberately share the `zh` (simplified Chinese)
 *     source — documented gap.
 *   - `allowlist`: per-locale false-positive overrides from
 *     `./allowlist/<locale>.json`. Merged with `global.json` at matcher
 *     compile time.
 *   - `script`: selects the matching algorithm. Latin-script locales use
 *     Unicode-aware word-boundary regex; CJK locales use substring match
 *     because LDNOOBW CJK entries are designed for substring matching —
 *     word boundaries don't apply the way they do in space-delimited
 *     scripts.
 */
interface LocaleGuardrailConfig {
  readonly wordlist: readonly string[];
  readonly allowlist: readonly string[];
  readonly script: 'latin' | 'cjk';
}

const LOCALE_CONFIG: Record<GuardrailSupportedLocale, LocaleGuardrailConfig> = {
  'de-DE': { wordlist: deWords, allowlist: deDEAllow, script: 'latin' },
  'es-ES': { wordlist: esWords, allowlist: esESAllow, script: 'latin' },
  'fr-FR': { wordlist: frWords, allowlist: frFRAllow, script: 'latin' },
  'it-IT': { wordlist: itWords, allowlist: itITAllow, script: 'latin' },
  'pt-BR': { wordlist: ptWords, allowlist: ptBRAllow, script: 'latin' },
  'ja-JP': { wordlist: jaWords, allowlist: jaJPAllow, script: 'cjk' },
  'ko-KR': { wordlist: koWords, allowlist: koKRAllow, script: 'cjk' },
  'zh-CN': { wordlist: zhWords, allowlist: zhCNAllow, script: 'cjk' },
  'zh-TW': { wordlist: zhWords, allowlist: zhTWAllow, script: 'cjk' }
};

export interface GuardrailResult {
  /** True if the text did not match any wordlist entry, OR the check was skipped. */
  passed: boolean;
  /**
   * The locale the check was requested for. Typed as `string` because
   * `checkProfanity` accepts any locale (and safely narrows internally to
   * decide whether a wordlist applies); callers may pass locales outside
   * `GUARDRAIL_SUPPORTED_LOCALES` and get a `skipped: true` result.
   */
  locale: string;
  /** Wordlist entries that matched. Empty when `passed` is true. */
  matches: string[];
  /** Which wordlist was applied, or `null` if the locale is out of scope. */
  wordlistApplied: GuardrailSupportedLocale | null;
  /** Whether the check was skipped. */
  skipped: boolean;
  /** Reason for skip, if applicable. */
  skipReason?: 'locale_out_of_scope' | 'empty_text';
}

/**
 * Escapes regex metacharacters so a wordlist entry can be embedded safely in
 * a RegExp source. Unicode property escapes are used for the boundaries so
 * accented characters in e.g. French/German/Portuguese are treated as part
 * of a word.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-locale compiled matcher. Each locale carries EITHER a `regexes` array
 * (Latin path) OR a `substrings` array (CJK path). The `term` alongside each
 * regex lets us report the canonical wordlist entry on a match rather than
 * the regex source string.
 */
interface CompiledMatcher {
  kind: 'latin' | 'cjk';
  regexes: ReadonlyArray<{ pattern: RegExp; term: string }>;
  substrings: readonly string[];
}

/**
 * Merge the global allowlist with a per-locale file into a single lowercase
 * Set. Entries are NFC-normalized and lowercased at merge time so the
 * per-call path does no allowlist normalization.
 */
function mergeAllowlist(
  localeAllowlist: readonly string[]
): ReadonlySet<string> {
  const merged = new Set<string>();
  // Normalize each entry the same way wordlist entries are normalized at
  // compile time (NFC + lowercase + trim), so padded or differently-cased
  // allowlist entries still suppress their wordlist counterparts.
  for (const entry of globalAllowlist as readonly string[]) {
    const normalized = entry.normalize('NFC').toLowerCase().trim();
    if (normalized) merged.add(normalized);
  }
  for (const entry of localeAllowlist) {
    const normalized = entry.normalize('NFC').toLowerCase().trim();
    if (normalized) merged.add(normalized);
  }
  return merged;
}

/**
 * Build per-entry regexes for a Latin-script wordlist, skipping any entry
 * present in the merged allowlist. Returns one `{ pattern, term }` record per
 * retained wordlist entry so callers can report matches by canonical form.
 * We are creating regex patterns only for languages using Latin Scripts
 * because these languages use space separated words and we want to minimize
 * false positives because of this nature of the script.
 */
function compileLatinMatchers(
  wordlist: readonly string[],
  allowlist: ReadonlySet<string>
): Array<{ pattern: RegExp; term: string }> {
  const out: Array<{ pattern: RegExp; term: string }> = [];
  const seen = new Set<string>();
  for (const raw of wordlist) {
    const term = raw.normalize('NFC').toLowerCase().trim();
    if (!term || seen.has(term) || allowlist.has(term)) continue;
    seen.add(term);
    out.push({
      pattern: new RegExp(
        `(^|[^\\p{L}\\p{N}])${escapeRegex(term)}([^\\p{L}\\p{N}]|$)`,
        'iu'
      ),
      term
    });
  }
  return out;
}

/**
 * Build an NFC-normalized lowercase substring list for a CJK wordlist,
 * skipping any entry present in the merged allowlist.
 */
function compileCjkSubstrings(
  wordlist: readonly string[],
  allowlist: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of wordlist) {
    const term = raw.normalize('NFC').toLowerCase().trim();
    if (!term || seen.has(term) || allowlist.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * This creates an object with all 9 supported locales along with their
 * regexes (for latin script) and substrings (for CJK scripts).
 * The output follows the following pattern:
 */
//   MATCHERS = {
//   'de-DE': { kind: 'latin', regexes: [ /* 66 entries */ ], substrings: [] },
//   'es-ES': { kind: 'latin', regexes: [ /* 68 entries */ ], substrings: [] },
//   'fr-FR': { kind: 'latin', regexes: [ /* 91 entries */ ], substrings: [] },
//   'it-IT': { kind: 'latin', regexes: [ /* 168 entries */ ], substrings: [] },
//   'pt-BR': { kind: 'latin', regexes: [ /* 76 entries */ ], substrings: [] },
//   'ja-JP': { kind: 'cjk',   regexes: [], substrings: [ /* 180 entries */ ] },
//   'ko-KR': { kind: 'cjk',   regexes: [], substrings: [ /*  72 entries */ ] },
//   'zh-CN': { kind: 'cjk',   regexes: [], substrings: [ /* 318 entries */ ] },
//   'zh-TW': { kind: 'cjk',   regexes: [], substrings: [ /* 318 entries */ ] }
// }
const MATCHERS: Record<GuardrailSupportedLocale, CompiledMatcher> = (() => {
  const out = {} as Record<GuardrailSupportedLocale, CompiledMatcher>;
  for (const locale of GUARDRAIL_SUPPORTED_LOCALES) {
    const config = LOCALE_CONFIG[locale];
    const allowlist = mergeAllowlist(config.allowlist);
    if (config.script === 'cjk') {
      out[locale] = {
        kind: 'cjk',
        regexes: [],
        substrings: compileCjkSubstrings(config.wordlist, allowlist)
      };
    } else {
      out[locale] = {
        kind: 'latin',
        regexes: compileLatinMatchers(config.wordlist, allowlist),
        substrings: []
      };
    }
  }
  return out;
})();

function isGuardrailSupported(
  locale: string
): locale is GuardrailSupportedLocale {
  return (GUARDRAIL_SUPPORTED_LOCALES as readonly string[]).includes(locale);
}

/**
 * Checks translated text against the LDNOOBW-derived profanity wordlist for
 * the target locale.
 *
 * Behavior:
 * - Empty or whitespace-only text → `passed: true, skipped: true, skipReason: 'empty_text'`.
 * - Locale not in `GUARDRAIL_SUPPORTED_LOCALES` → `passed: true, skipped: true, skipReason: 'locale_out_of_scope'`.
 * - Otherwise: lowercase + NFC normalize the input and test against the
 *   locale's compiled matcher. Latin-script locales use word-boundary regex;
 *   CJK locales use substring match. Short-circuits on the first match.
 */
export function checkProfanity(text: string, locale: string): GuardrailResult {
  if (!text || !text.trim()) {
    return {
      passed: true,
      locale,
      matches: [],
      wordlistApplied: isGuardrailSupported(locale) ? locale : null,
      skipped: true,
      skipReason: 'empty_text'
    };
  }

  if (!isGuardrailSupported(locale)) {
    return {
      passed: true,
      locale,
      matches: [],
      wordlistApplied: null,
      skipped: true,
      skipReason: 'locale_out_of_scope'
    };
  }

  const matcher = MATCHERS[locale];
  const normalized = text.normalize('NFC').toLowerCase();

  if (matcher.kind === 'cjk') {
    for (const term of matcher.substrings) {
      if (normalized.includes(term)) {
        return {
          passed: false,
          locale,
          matches: [term],
          wordlistApplied: locale,
          skipped: false
        };
      }
    }
  } else {
    for (const { pattern, term } of matcher.regexes) {
      if (pattern.test(normalized)) {
        return {
          passed: false,
          locale,
          matches: [term],
          wordlistApplied: locale,
          skipped: false
        };
      }
    }
  }

  return {
    passed: true,
    locale,
    matches: [],
    wordlistApplied: locale,
    skipped: false
  };
}

/**
 * Internals exposed for unit tests only. Not part of the public API.
 */
export const __testing = {
  MATCHERS,
  mergeAllowlist,
  compileLatinMatchers,
  compileCjkSubstrings,
  escapeRegex
};
