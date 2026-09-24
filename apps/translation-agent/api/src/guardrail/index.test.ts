import { describe, it, expect } from 'vitest';
import {
  checkProfanity,
  GUARDRAIL_SUPPORTED_LOCALES,
  __testing,
  type GuardrailSupportedLocale
} from './index';

/**
 * Notes on test strategy:
 *
 * To avoid committing actual profanity to source control, the should-flag
 * tests sample real wordlist entries from `__testing.MATCHERS` at runtime and
 * verify they trigger a match when embedded in surrounding text. This
 * exercises the full matcher path without hardcoding offensive strings.
 *
 * The should-pass tests use synthetic clean strings (natural translations
 * of a product welcome/status message per locale) drawn from non-LDNOOBW
 * vocabulary. These are hand-written and safe to commit.
 */

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Sample a small set of term indices for a locale (first, middle, last) to
 * give the should-flag tests variety without enumerating every entry.
 */
function sampleIndices(total: number): number[] {
  if (total === 0) return [];
  if (total === 1) return [0];
  if (total === 2) return [0, 1];
  return [0, Math.floor(total / 2), total - 1];
}

/** Pick the Nth canonical term (wordlist-entry form) from a locale's matcher. */
function termAt(
  locale: GuardrailSupportedLocale,
  index: number
): string | null {
  const m = __testing.MATCHERS[locale];
  if (m.kind === 'latin') return m.regexes[index]?.term ?? null;
  return m.substrings[index] ?? null;
}

/**
 * Construct a test string that embeds a wordlist term in a locale-appropriate
 * surrounding context. For Latin scripts, surround with spaces; for CJK,
 * surround with neutral CJK characters so we exercise the substring path
 * rather than accidentally triggering a word boundary.
 */
function embed(locale: GuardrailSupportedLocale, term: string): string {
  const isCjk = (
    ['ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'] as GuardrailSupportedLocale[]
  ).includes(locale);
  return isCjk ? `普通文本${term}更多内容` : `hello ${term} world`;
}

/** Clean strings per locale — no LDNOOBW vocabulary, safe to commit. */
const CLEAN_SAMPLES: Record<GuardrailSupportedLocale, string[]> = {
  'de-DE': [
    'Willkommen bei Cloudflare. Die Konfiguration wurde gespeichert.',
    'Bitte überprüfen Sie die Einstellungen und klicken Sie auf Weiter.',
    'Ihr Konto wurde erfolgreich aktualisiert.'
  ],
  'es-ES': [
    'Bienvenido a Cloudflare. La configuración se ha guardado.',
    'Por favor, revise los ajustes y haga clic en continuar.',
    'Su cuenta se ha actualizado correctamente.'
  ],
  'fr-FR': [
    'Bienvenue sur Cloudflare. La configuration a été enregistrée.',
    'Veuillez vérifier les paramètres et cliquer sur continuer.',
    'Votre compte a été mis à jour avec succès.'
  ],
  'it-IT': [
    'Benvenuto in Cloudflare. La configurazione è stata salvata.',
    'Si prega di controllare le impostazioni e fare clic su continua.',
    'Il tuo account è stato aggiornato con successo.'
  ],
  'pt-BR': [
    'Bem-vindo ao Cloudflare. A configuração foi salva.',
    'Por favor, verifique as configurações e clique em continuar.',
    'Sua conta foi atualizada com sucesso.'
  ],
  'ja-JP': [
    'Cloudflareへようこそ。設定が保存されました。',
    '設定を確認して、続行をクリックしてください。',
    'アカウントが正常に更新されました。'
  ],
  'ko-KR': [
    'Cloudflare에 오신 것을 환영합니다. 설정이 저장되었습니다.',
    '설정을 확인하고 계속을 클릭하세요.',
    '계정이 성공적으로 업데이트되었습니다.'
  ],
  'zh-CN': [
    '欢迎使用 Cloudflare。配置已保存。',
    '请检查设置并点击继续。',
    '您的账户已成功更新。'
  ],
  'zh-TW': [
    '歡迎使用 Cloudflare。設定已儲存。',
    '請檢查設定並點擊繼續。',
    '您的帳戶已成功更新。'
  ]
};

// --------------------------------------------------------------------------
// Supported locales + matcher construction
// --------------------------------------------------------------------------

describe('GUARDRAIL_SUPPORTED_LOCALES', () => {
  it('lists the 9 Stratus-scoped locales', () => {
    expect([...GUARDRAIL_SUPPORTED_LOCALES]).toEqual([
      'de-DE',
      'es-ES',
      'fr-FR',
      'it-IT',
      'ja-JP',
      'ko-KR',
      'pt-BR',
      'zh-CN',
      'zh-TW'
    ]);
  });
});

describe('MATCHERS construction', () => {
  it('builds a latin matcher for each Latin-script locale', () => {
    for (const locale of [
      'de-DE',
      'es-ES',
      'fr-FR',
      'it-IT',
      'pt-BR'
    ] as GuardrailSupportedLocale[]) {
      const m = __testing.MATCHERS[locale];
      expect(m.kind).toBe('latin');
      expect(m.regexes.length).toBeGreaterThan(0);
      expect(m.substrings).toHaveLength(0);
    }
  });

  it('builds a cjk matcher for each CJK locale', () => {
    for (const locale of [
      'ja-JP',
      'ko-KR',
      'zh-CN',
      'zh-TW'
    ] as GuardrailSupportedLocale[]) {
      const m = __testing.MATCHERS[locale];
      expect(m.kind).toBe('cjk');
      expect(m.substrings.length).toBeGreaterThan(0);
      expect(m.regexes).toHaveLength(0);
    }
  });

  it('has zh-CN and zh-TW use the same underlying wordlist', () => {
    // Structural check, not a behavioral one. Both locales share the `zh`
    // LDNOOBW file; after NFC+lowercase+dedup they must yield identical
    // substring sets.
    const zhCN = __testing.MATCHERS['zh-CN'];
    const zhTW = __testing.MATCHERS['zh-TW'];
    expect(zhCN.kind).toBe('cjk');
    expect(zhTW.kind).toBe('cjk');
    expect([...zhCN.substrings].sort()).toEqual([...zhTW.substrings].sort());
  });
});

// --------------------------------------------------------------------------
// Clean-text path (should pass)
// --------------------------------------------------------------------------

describe('checkProfanity — clean text', () => {
  for (const locale of GUARDRAIL_SUPPORTED_LOCALES) {
    for (const sample of CLEAN_SAMPLES[locale]) {
      it(`${locale}: passes "${sample.slice(0, 40)}..."`, () => {
        const r = checkProfanity(sample, locale);
        expect(r.passed).toBe(true);
        expect(r.skipped).toBe(false);
        expect(r.matches).toEqual([]);
        expect(r.wordlistApplied).toBe(locale);
        expect(r.skipReason).toBeUndefined();
      });
    }
  }
});

// --------------------------------------------------------------------------
// Dirty-text path (should flag) — sampled from real wordlists at runtime
// --------------------------------------------------------------------------

describe('checkProfanity — flagged text (sampled from wordlists)', () => {
  for (const locale of GUARDRAIL_SUPPORTED_LOCALES) {
    const m = __testing.MATCHERS[locale];
    const total = m.kind === 'latin' ? m.regexes.length : m.substrings.length;
    const indices = sampleIndices(total);

    for (const i of indices) {
      it(`${locale}: flags wordlist entry at index ${i}`, () => {
        const chosen = termAt(locale, i);
        if (chosen === null) {
          throw new Error(`termAt(${locale}, ${i}) returned null`);
        }
        const input = embed(locale, chosen);
        const r = checkProfanity(input, locale);
        expect(r.passed).toBe(false);
        expect(r.skipped).toBe(false);
        expect(r.matches).toHaveLength(1);
        expect(r.wordlistApplied).toBe(locale);

        // The reported match may not be exactly `chosen` — if another
        // wordlist entry is a substring of `chosen` (e.g. ja "ポルノ" inside
        // "ポルノグラフィー"), the matcher's iteration order may surface the
        // shorter entry first. What must be true: the matched term IS in
        // the locale's wordlist and IS contained in the input.
        const matched = r.matches[0];
        const wordlist =
          m.kind === 'latin' ? m.regexes.map((e) => e.term) : [...m.substrings];
        expect(wordlist).toContain(matched);
        expect(input.toLowerCase().normalize('NFC')).toContain(matched);
      });
    }
  }
});

// --------------------------------------------------------------------------
// Skip reasons
// --------------------------------------------------------------------------

describe('checkProfanity — skip semantics', () => {
  it('returns skipped=true with skipReason=empty_text for empty string', () => {
    const r = checkProfanity('', 'es-ES');
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('empty_text');
    expect(r.matches).toEqual([]);
    // Locale is supported → wordlistApplied is populated.
    expect(r.wordlistApplied).toBe('es-ES');
  });

  it('returns skipped=true with skipReason=empty_text for whitespace-only', () => {
    const r = checkProfanity('   \n\t  ', 'ja-JP');
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('empty_text');
    expect(r.wordlistApplied).toBe('ja-JP');
  });

  it('returns wordlistApplied=null when empty text is paired with an unsupported locale', () => {
    // Edge: the empty-text branch runs before the locale-support branch, but
    // for out-of-scope locales we still want wordlistApplied=null since there
    // is no applicable wordlist.
    const r = checkProfanity('', 'ar-EG');
    expect(r.passed).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toBe('empty_text');
    expect(r.wordlistApplied).toBeNull();
  });

  const outOfScopeLocales = ['ar-EG', 'ru-RU', 'vi-VN'] as const;
  for (const locale of outOfScopeLocales) {
    it(`returns locale_out_of_scope for unsupported locale ${locale}`, () => {
      const r = checkProfanity('hello world this is clean text', locale);
      expect(r.passed).toBe(true);
      expect(r.skipped).toBe(true);
      expect(r.skipReason).toBe('locale_out_of_scope');
      expect(r.wordlistApplied).toBeNull();
      expect(r.matches).toEqual([]);
    });
  }
});

// --------------------------------------------------------------------------
// Matching algorithm correctness
// --------------------------------------------------------------------------

describe('Latin-script word boundaries (Scunthorpe test)', () => {
  // Embed a real wordlist term inside a larger token and verify it does NOT
  // match. Applies to es/fr/de/it/pt.
  const latinLocales: GuardrailSupportedLocale[] = [
    'de-DE',
    'es-ES',
    'fr-FR',
    'it-IT',
    'pt-BR'
  ];
  /**
   * Finds a purely-alphabetic term in a Latin locale's matcher. Throws
   * rather than returning undefined so tests can use the returned term
   * directly without non-null assertions.
   */
  const findLatinAlphaTerm = (
    locale: GuardrailSupportedLocale
  ): { pattern: RegExp; term: string } => {
    const m = __testing.MATCHERS[locale];
    if (m.kind !== 'latin') throw new Error('expected latin matcher');
    const candidate = m.regexes.find((r) => /^\p{L}+$/u.test(r.term));
    if (candidate === undefined) {
      throw new Error(`no purely-alphabetic term available for ${locale}`);
    }
    return candidate;
  };

  for (const locale of latinLocales) {
    it(`${locale}: "pre${'<term>'}post" (embedded, no boundaries) does not match`, () => {
      const candidate = findLatinAlphaTerm(locale);
      const embedded = `pre${candidate.term}post`;
      const r = checkProfanity(embedded, locale);
      expect(r.passed).toBe(true);
      expect(r.skipped).toBe(false);
    });

    it(`${locale}: term surrounded by punctuation does match`, () => {
      const candidate = findLatinAlphaTerm(locale);
      const punctuated = `Note: ${candidate.term}, please review.`;
      const r = checkProfanity(punctuated, locale);
      expect(r.passed).toBe(false);
      expect(r.matches).toEqual([candidate.term]);
    });
  }

  it('is case-insensitive on the Latin path', () => {
    const candidate = findLatinAlphaTerm('es-ES');
    const upper = `Warning ${candidate.term.toUpperCase()} detected`;
    const r = checkProfanity(upper, 'es-ES');
    expect(r.passed).toBe(false);
    expect(r.matches[0]).toBe(candidate.term);
  });
});

describe('CJK substring matching', () => {
  const cjkLocales: GuardrailSupportedLocale[] = [
    'ja-JP',
    'ko-KR',
    'zh-CN',
    'zh-TW'
  ];
  for (const locale of cjkLocales) {
    it(`${locale}: term embedded in surrounding text matches (substring path)`, () => {
      const m = __testing.MATCHERS[locale];
      if (m.kind !== 'cjk') throw new Error('expected cjk matcher');
      const term = m.substrings[0];
      const input = `前置文字${term}後置文字`;
      const r = checkProfanity(input, locale);
      expect(r.passed).toBe(false);
      expect(r.matches).toEqual([term]);
    });
  }
});

describe('NFC normalization', () => {
  // Construct a string using a decomposed form (NFD) and verify it matches
  // the same term added via its NFC form. Works on the Latin path because
  // many Romance/Germanic locales use combining accents. Pick a term that
  // contains a character with a combining-mark decomposition.
  it('composed and decomposed forms both match (fr-FR)', () => {
    const m = __testing.MATCHERS['fr-FR'];
    if (m.kind !== 'latin') throw new Error('expected latin matcher');
    const accented = m.regexes.find((r) => /[àâäéèêëïîôöùûüÿñç]/i.test(r.term));
    if (!accented) {
      // No accented term in the wordlist — skip without failing.
      return;
    }
    const nfc = accented.term.normalize('NFC');
    const nfd = accented.term.normalize('NFD');
    expect(nfc).not.toBe(nfd); // sanity: the decomposition actually differs

    const inputNfc = `prefixe ${nfc} suffixe`;
    const inputNfd = `prefixe ${nfd} suffixe`;
    const rNfc = checkProfanity(inputNfc, 'fr-FR');
    const rNfd = checkProfanity(inputNfd, 'fr-FR');
    expect(rNfc.passed).toBe(false);
    expect(rNfd.passed).toBe(false);
    expect(rNfc.matches).toEqual(rNfd.matches);
  });
});

// --------------------------------------------------------------------------
// Allowlist semantics
// --------------------------------------------------------------------------

describe('allowlist merging', () => {
  it('starts with no private global entries in the public snapshot', () => {
    const merged = __testing.mergeAllowlist([]);
    expect(merged.size).toBe(0);
  });

  it('normalizes entries to NFC + lowercase + trim at merge time', () => {
    const merged = __testing.mergeAllowlist([
      'MixedCase',
      '  padded  ',
      'café' // relies on NFC of the literal
    ]);
    expect(merged.has('mixedcase')).toBe(true);
    // Entries are trimmed at merge time to match how wordlist entries are
    // normalized during matcher compilation. A padded allowlist entry like
    // "  padded  " is stored as "padded" so it actually suppresses any
    // matching trimmed wordlist term.
    expect(merged.has('padded')).toBe(true);
    expect(merged.has('  padded  ')).toBe(false);
    expect(merged.has('café'.normalize('NFC'))).toBe(true);
  });

  it('drops allowlist entries that are empty after normalization', () => {
    const merged = __testing.mergeAllowlist(['   ', '']);
    // Empty/whitespace-only entries are skipped — they would otherwise
    // add a useless '' to the set and (if they slipped through) could
    // suppress every wordlist entry via a vacuous match.
    expect(merged.has('')).toBe(false);
  });

  it('removes an allowlisted term from the compiled matcher', () => {
    // Take a real term from es-ES, allowlist it, re-run the compile, and
    // verify it no longer appears in the output.
    const m = __testing.MATCHERS['es-ES'];
    if (m.kind !== 'latin') throw new Error('expected latin matcher');
    const sampleTerm = m.regexes[0].term;

    const rawWordlist = [sampleTerm, 'someotherterm'];
    const recompiled = __testing.compileLatinMatchers(
      rawWordlist,
      new Set([sampleTerm])
    );
    expect(recompiled.map((r) => r.term)).toEqual(['someotherterm']);
  });

  it('skips an allowlisted CJK term from the compiled substring list', () => {
    const m = __testing.MATCHERS['zh-CN'];
    if (m.kind !== 'cjk') throw new Error('expected cjk matcher');
    const sampleTerm = m.substrings[0];

    const rawWordlist = [sampleTerm, '正常词汇'];
    const recompiled = __testing.compileCjkSubstrings(
      rawWordlist,
      new Set([sampleTerm])
    );
    expect(recompiled).toEqual(['正常词汇']);
  });
});

// --------------------------------------------------------------------------
// Internals — regex escaping
// --------------------------------------------------------------------------

describe('escapeRegex', () => {
  it('escapes regex metacharacters', () => {
    expect(__testing.escapeRegex('a.b')).toBe('a\\.b');
    expect(__testing.escapeRegex('a+b*c?')).toBe('a\\+b\\*c\\?');
    expect(__testing.escapeRegex('a(b)c[d]')).toBe('a\\(b\\)c\\[d\\]');
    expect(__testing.escapeRegex('a$b^c|d')).toBe('a\\$b\\^c\\|d');
    expect(__testing.escapeRegex('a\\b')).toBe('a\\\\b');
  });

  it('leaves non-metacharacters untouched', () => {
    expect(__testing.escapeRegex('hello world')).toBe('hello world');
    expect(__testing.escapeRegex('café')).toBe('café');
    expect(__testing.escapeRegex('中文')).toBe('中文');
  });
});
