/** Site locale code → BCP 47 tag, for codes `Intl` would misread (`jp` → `ja`, `es-la` → `es-419`). */
export type LocaleTags = Readonly<Record<string, string>>;

export interface LocaleTagIssue {
  locale: string;
  tag: string;
  reason: "malformed" | "unsupported" | "undeclared";
}

const CLDR_CATEGORY_ORDER = ["zero", "one", "two", "few", "many", "other"];
const supportedTagCache = new Map<string, string | undefined>();
const requiredCategoryCache = new Map<string, string[]>();

/** The BCP 47 tag for a site locale code: its `localeTags` entry, or the code itself. */
export function resolveLocaleTag(locale: string, localeTags?: LocaleTags | undefined): string {
  return localeTags !== undefined && Object.hasOwn(localeTags, locale) ? (localeTags[locale] ?? locale) : locale;
}

/** Canonical form of `tag` when it is well-formed and `Intl` knows its language; otherwise `undefined`. */
export function supportedLocaleTag(tag: string | undefined): string | undefined {
  if (tag === undefined || tag.length === 0) return undefined;
  if (supportedTagCache.has(tag)) return supportedTagCache.get(tag);
  let supported: string | undefined;
  try {
    supported = Intl.PluralRules.supportedLocalesOf([tag])[0];
  } catch {
    supported = undefined;
  }
  supportedTagCache.set(tag, supported);
  return supported;
}

/** Problems with `localeTags` for the configured `locales`. Empty means every locale resolves to a usable tag. */
export function checkLocaleTags(locales: readonly string[], localeTags?: LocaleTags | undefined): LocaleTagIssue[] {
  const issues: LocaleTagIssue[] = [];
  for (const [locale, tag] of Object.entries(localeTags ?? {})) {
    if (!locales.includes(locale)) issues.push({ locale, tag, reason: "undeclared" });
  }
  for (const locale of locales) {
    const tag = resolveLocaleTag(locale, localeTags);
    let malformed = false;
    try {
      Intl.getCanonicalLocales(tag);
    } catch {
      malformed = true;
    }
    if (malformed) issues.push({ locale, tag, reason: "malformed" });
    else if (supportedLocaleTag(tag) === undefined) issues.push({ locale, tag, reason: "unsupported" });
  }
  return issues;
}

export function formatLocaleTagIssues(issues: readonly LocaleTagIssue[]): string {
  return issues
    .map((issue) => {
      if (issue.reason === "undeclared") return `localeTags key "${issue.locale}" is not one of the configured locales.`;
      const problem = issue.reason === "malformed" ? "is not a valid BCP 47 tag" : "names a language Intl does not recognise";
      return `locale "${issue.locale}" uses tag "${issue.tag}", which ${problem}. Map it with localeTags: { "${issue.locale}": "<BCP 47 tag>" }.`;
    })
    .join("\n");
}

/** Throws with every issue listed when `localeTags` does not fit `locales`. */
export function assertLocaleTags(locales: readonly string[], localeTags: LocaleTags | undefined, label: string): void {
  const issues = checkLocaleTags(locales, localeTags);
  if (issues.length > 0) throw new Error(`[${label}] invalid locale tags:\n${formatLocaleTagIssues(issues)}`);
}

/** Validates an untrusted `localeTags` value: a plain object of non-empty strings. */
export function parseLocaleTags(value: unknown, label: string): LocaleTags | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`[${label}] localeTags must be an object`);
  const tags: Record<string, string> = {};
  for (const [locale, tag] of Object.entries(value)) {
    if (typeof tag !== "string" || tag.length === 0) throw new Error(`[${label}] localeTags.${locale} must be a non-empty string`);
    tags[locale] = tag;
  }
  return tags;
}

/**
 * Categories a translation must write: those some count from 0 to 1000 selects, plus `other`.
 * Excludes `many` in fr/es/it (exact millions only) and decimal-only categories (`many` in cs).
 */
export function requiredPluralCategories(tag: string, type: Intl.PluralRuleType = "cardinal"): string[] {
  const key = `${type}\u0000${tag}`;
  const cached = requiredCategoryCache.get(key);
  if (cached !== undefined) return cached;
  const rules = new Intl.PluralRules(supportedLocaleTag(tag), { type });
  const selected = new Set(["other"]);
  for (let count = 0; count <= 1000; count++) selected.add(rules.select(count));
  const required = CLDR_CATEGORY_ORDER.filter((category) => selected.has(category));
  requiredCategoryCache.set(key, required);
  return required;
}

/** Plural categories `tag` uses, in CLDR order (zero, one, two, few, many, other). */
export function pluralCategories(tag: string, type: Intl.PluralRuleType = "cardinal"): string[] {
  const categories: readonly string[] = new Intl.PluralRules(supportedLocaleTag(tag), { type }).resolvedOptions().pluralCategories;
  return CLDR_CATEGORY_ORDER.filter((category) => categories.includes(category));
}
