import { describe, it, expect } from 'vitest';
import {
  validateTranslationEntry,
  validateVariablePlaceholders
} from './validation-utils';
import { __testing as guardrailInternals } from './guardrail';

describe('validatePlaceholdersMatch', () => {
  describe('valid cases - strings', () => {
    it('should pass when both strings have the same placeholders in order', () => {
      const original = 'My name is {{variable1}} and I live in {{variable2}}';
      const translated = 'Mi nombre es {{variable1}} y vivo en {{variable2}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass when no placeholders exist in either string', () => {
      const original = 'Hello world';
      const translated = 'Hola mundo';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with multiple occurrences of same placeholder', () => {
      const original = '{{user}} said hello to {{user}}';
      const translated = '{{user}} dijo hola a {{user}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with complex placeholder names', () => {
      const original = 'Welcome {{user.name}} to {{company.location}}';
      const translated = 'Bienvenido {{user.name}} a {{company.location}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with %{} placeholders', () => {
      const original = 'My name is %{name} and I am %{age} years old';
      const translated = 'Mi nombre es %{name} y tengo %{age} años';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with mixed {{}} and %{} placeholders', () => {
      const original = 'Hello {{username}}, you have %{count} messages';
      const translated = 'Hola {{username}}, tienes %{count} mensajes';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass with %{} placeholders in correct order', () => {
      const original = 'From %{start} to %{end}';
      const translated = 'Desde %{start} hasta %{end}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('invalid cases - strings', () => {
    it('should fail when translated is missing placeholders', () => {
      const original = 'My name is {{variable1}} and I live in {{variable2}}';
      const translated = 'Mi nombre es Juan y vivo en Madrid';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder count mismatch: original has 2, translated has 0'
      );
    });

    it.skip('should fail when placeholders are in wrong order', () => {
      const original = 'My name is {{variable1}} and I live in {{variable2}}';
      const translated = 'Mi nombre es {{variable2}} y vivo en {{variable1}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder mismatch at position 1: expected "{{variable1}}", found "{{variable2}}"'
      );
    });

    it.skip('should fail when translated has different placeholder names', () => {
      const original = 'Hello {{name}}';
      const translated = 'Hola {{nombre}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder mismatch at position 1: expected "{{name}}", found "{{nombre}}"'
      );
    });

    it('should fail when translated has extra placeholders', () => {
      const original = 'Hello {{name}}';
      const translated = 'Hola {{name}} from {{city}}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder count mismatch: original has 1, translated has 2'
      );
    });

    it('should fail when %{} placeholders are missing', () => {
      const original = 'My name is %{name} and I am %{age} years old';
      const translated = 'Mi nombre es Juan y tengo 30 años';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder count mismatch: original has 2, translated has 0'
      );
    });

    it.skip('should fail when %{} placeholders are in wrong order', () => {
      const original = 'From %{start} to %{end}';
      const translated = 'Desde %{end} hasta %{start}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder mismatch at position 1: expected "%{start}", found "%{end}"'
      );
    });

    it('should fail when mixed placeholders are missing', () => {
      const original = 'Hello {{username}}, you have %{count} messages';
      const translated = 'Hola, tienes mensajes';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder count mismatch: original has 2, translated has 0'
      );
    });

    it.skip('should fail when %{} placeholder names differ', () => {
      const original = 'Hello %{name}';
      const translated = 'Hola %{nombre}';

      const result = validateVariablePlaceholders(original, translated);

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        'Placeholder mismatch at position 1: expected "%{name}", found "%{nombre}"'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// validateTranslationEntry — content guardrail integration
//
// These tests verify ONLY the guardrail gating behavior introduced in step 6.
// Placeholder-validation behavior is covered separately in translate-text
// tests and is not re-asserted here.
// ---------------------------------------------------------------------------

/**
 * Pull a real Spanish wordlist term at runtime so we don't commit profanity
 * to the test file. es-ES is Latin-script so we can embed with spaces and
 * rely on word boundaries.
 */
function esWordlistSampleTerm(): string {
  const m = guardrailInternals.MATCHERS['es-ES'];
  if (m.kind !== 'latin') throw new Error('expected latin matcher for es-ES');
  const candidate = m.regexes.find((r) => /^\p{L}+$/u.test(r.term));
  if (!candidate) throw new Error('no purely-alphabetic term available');
  return candidate.term;
}

describe('validateTranslationEntry — guardrail integration', () => {
  const cleanSource = 'Welcome to our service.';
  const cleanTranslation = 'Bienvenido a nuestro servicio.';

  describe('off mode', () => {
    it('does not populate guardrail field on clean text', () => {
      const result = validateTranslationEntry(
        cleanSource,
        cleanTranslation,
        'welcome',
        'es-ES',
        'off'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });

    it('does not populate guardrail field even if translation would flag', () => {
      const term = esWordlistSampleTerm();
      const flaggable = `hola ${term} mundo`;
      const result = validateTranslationEntry(
        'hello clean world',
        flaggable,
        'welcome',
        'es-ES',
        'off'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });
  });

  describe('shadow mode', () => {
    it('does not affect success when translation is clean', () => {
      const result = validateTranslationEntry(
        cleanSource,
        cleanTranslation,
        'welcome',
        'es-ES',
        'shadow'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });

    it('populates guardrail field but leaves success=true when flagged', () => {
      const term = esWordlistSampleTerm();
      const flaggable = `hola ${term} mundo`;
      const result = validateTranslationEntry(
        'hello clean world',
        flaggable,
        'welcome',
        'es-ES',
        'shadow'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      const { guardrail } = result;
      if (guardrail === undefined) {
        throw new Error('expected result.guardrail to be populated');
      }
      expect(guardrail.subKey).toBe('welcome');
      expect(guardrail.locale).toBe('es-ES');
      expect(guardrail.wordlistApplied).toBe('es-ES');
      expect(guardrail.matches.length).toBeGreaterThan(0);
    });

    it('skips guardrail for out-of-scope locale (passed=true, skipped=true upstream)', () => {
      // The guardrail check returns skipped=true for ar-EG, which the
      // validator interprets as "nothing to record". No guardrail field.
      const result = validateTranslationEntry(
        'hello world',
        'مرحبا بالعالم',
        'welcome',
        'ar-EG',
        'shadow'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });

    it('records only the first flagged pair when entry is a nested object', () => {
      // Build a nested entry where two sub-keys would both trigger a flag.
      // Only the first should populate `guardrail`.
      const term = esWordlistSampleTerm();
      const source = { a: 'hello', b: 'world' };
      const translated = {
        a: `hola ${term} primero`,
        b: `hola ${term} segundo`
      };
      const result = validateTranslationEntry(
        source,
        translated,
        'file',
        'es-ES',
        'shadow'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      const { guardrail } = result;
      if (guardrail === undefined) {
        throw new Error('expected result.guardrail to be populated');
      }
      // subKey carries the dotted path; "file.a" should win (first pair).
      expect(guardrail.subKey).toBe('file.a');
    });
  });

  describe('enforce mode', () => {
    it('does not affect success when translation is clean', () => {
      const result = validateTranslationEntry(
        cleanSource,
        cleanTranslation,
        'welcome',
        'es-ES',
        'enforce'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });

    it('sets success=false, pushes a redacted error, and populates guardrail on flag', () => {
      const term = esWordlistSampleTerm();
      const flaggable = `hola ${term} mundo`;
      const result = validateTranslationEntry(
        'hello clean world',
        flaggable,
        'welcome',
        'es-ES',
        'enforce'
      );
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Content guardrail flagged');
      expect(result.errors[0]).toContain('welcome');
      expect(result.errors[0]).toContain('es-ES');
      // Critical: the matched term itself MUST NOT appear in the error string.
      expect(result.errors[0]).not.toContain(term);
      const { guardrail } = result;
      if (guardrail === undefined) {
        throw new Error('expected result.guardrail to be populated');
      }
      expect(guardrail.matches.length).toBeGreaterThan(0);
    });

    it('guardrail is not invoked when placeholder check fails first', () => {
      // A translation with a placeholder mismatch AND profanity should surface
      // the placeholder error, not the guardrail flag — the order in the
      // validator is placeholder-first, and we break before guardrail.
      const term = esWordlistSampleTerm();
      const source = 'Hello {{name}}';
      const translated = `Hola ${term}`; // missing {{name}}
      const result = validateTranslationEntry(
        source,
        translated,
        'welcome',
        'es-ES',
        'enforce'
      );
      expect(result.success).toBe(false);
      // Exactly one error, and it is the placeholder error, not guardrail.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Variable placeholder');
      expect(result.guardrail).toBeUndefined();
    });

    it('out-of-scope locale produces no flag and no error', () => {
      const result = validateTranslationEntry(
        'hello world',
        'some translated text',
        'welcome',
        'ar-EG',
        'enforce'
      );
      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.guardrail).toBeUndefined();
    });
  });
});
