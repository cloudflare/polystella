// Valid locale codes
export const VALID_LOCALES = [
  // English (added for the Support team use case in UI-8255 — translate
  // INTO English from a customer's language). No bespoke terminology or
  // style guide exists for English yet; the prompt builder's
  // null-tolerant resource loaders fall back gracefully (empty
  // terminology section, default style guide). Add real English
  // resources when usage data justifies it.
  'en-US',
  // Primary locales
  'es-ES',
  'fr-FR',
  'de-DE',
  'it-IT',
  'pt-BR',
  'zh-CN',
  'ja-JP',
  'ko-KR',
  'zh-TW',
  // Additional locales
  'ar-EG',
  'bg-BG',
  'hr-HR',
  'cs-CZ',
  'da-DK',
  'nl-NL',
  'fa-IR',
  'fi-FI',
  'el-GR',
  'he-IL',
  'hi-IN',
  'hu-HU',
  'id-ID',
  'lv-LV',
  'lt-LT',
  'ms-MY',
  'nb-NO',
  'pl-PL',
  'ro-RO',
  'ru-RU',
  'sr-BA',
  'sk-SK',
  'sl-SI',
  'sv-SE',
  'tl-PH',
  'th-TH',
  'tr-TR',
  'uk-UA',
  'vi-VN'
] as const;

export type ValidLocale = (typeof VALID_LOCALES)[number];

/**
 *  A strict subset of `VALID_LOCALES` — aligned with Stratus-consumed
 * locales where LDNOOBW wordlist data is available and per-locale behavior
 * has been reviewed.
 *
 * Adding a locale here is a one-line change PLUS corresponding updates in
 * `api/src/guardrail/index.ts`:
 *   - Add the LDNOOBW wordlist `import` (e.g. `import arWords from 'naughty-words/ar.json'`)
 *   - Create a new `allowlist/<locale>.json` file and import it
 *   - Add one entry to `LOCALE_CONFIG` binding the locale to its wordlist,
 *     allowlist, and `script` ('latin' | 'cjk')
 */
export const GUARDRAIL_SUPPORTED_LOCALES = [
  'de-DE',
  'es-ES',
  'fr-FR',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'pt-BR',
  'zh-CN',
  'zh-TW'
] as const satisfies readonly ValidLocale[];

export type GuardrailSupportedLocale =
  (typeof GUARDRAIL_SUPPORTED_LOCALES)[number];
