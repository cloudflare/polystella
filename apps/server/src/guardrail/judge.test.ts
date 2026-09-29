import { describe, it, expect, assert } from 'vitest';
import { getJudgeModel, __testing } from './judge';
import type { ModelType } from '../llm-adapters';

const {
  JUDGE_MODEL_MAP,
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
  parseVerdicts,
  JUDGE_TIMEOUT_MS
} = __testing;

// ── getJudgeModel ─────────────────────────────────────────────────────────────

describe('getJudgeModel', () => {
  it('returns a different model than the translator for every known model', () => {
    const models: ModelType[] = ['kimi2_5', 'qwen', 'llama', 'gpt', 'glm'];
    for (const translator of models) {
      const judge = getJudgeModel(translator);
      expect(judge).not.toBe(translator);
      expect(typeof judge).toBe('string');
    }
  });

  it('maps kimi2_5 -> qwen', () => {
    expect(getJudgeModel('kimi2_5')).toBe('qwen');
  });

  it('maps qwen -> gpt (avoids self-judging)', () => {
    expect(getJudgeModel('qwen')).toBe('gpt');
  });

  it('maps llama -> qwen', () => {
    expect(getJudgeModel('llama')).toBe('qwen');
  });

  it('maps gpt -> qwen (avoids self-judging)', () => {
    expect(getJudgeModel('gpt')).toBe('qwen');
  });

  it('maps glm -> qwen', () => {
    expect(getJudgeModel('glm')).toBe('qwen');
  });

  it('falls back to llama for unknown model', () => {
    // @ts-expect-error — testing defensive fallback for unknown model
    expect(getJudgeModel('unknown_model')).toBe('llama');
  });
});

// ── JUDGE_MODEL_MAP ───────────────────────────────────────────────────────────

describe('JUDGE_MODEL_MAP', () => {
  it('covers all known translator models', () => {
    const expectedModels: ModelType[] = [
      'kimi2_5',
      'qwen',
      'llama',
      'gpt',
      'glm'
    ];
    for (const model of expectedModels) {
      expect(JUDGE_MODEL_MAP).toHaveProperty(model);
    }
  });

  it('never maps a model to itself', () => {
    for (const [translator, judge] of Object.entries(JUDGE_MODEL_MAP)) {
      expect(judge).not.toBe(translator);
    }
  });
});

// ── JUDGE_SYSTEM_PROMPT ───────────────────────────────────────────────────────

describe('JUDGE_SYSTEM_PROMPT', () => {
  it('mentions content safety', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('content safety');
  });

  it('includes false-positive avoidance for technical terms', () => {
    const technicalTerms = ['kill', 'abort', 'crash', 'terminate', 'execute'];
    for (const term of technicalTerms) {
      expect(JUDGE_SYSTEM_PROMPT).toContain(term);
    }
  });

  it('instructs JSON-only output', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('valid JSON only');
  });
});

// ── buildJudgeUserPrompt ──────────────────────────────────────────────────────

describe('buildJudgeUserPrompt', () => {
  const entries = [
    { key: 'greeting', source: 'Hello', translation: 'Hola' },
    { key: 'farewell', source: 'Goodbye', translation: 'Adiós' }
  ];

  it('includes the locale', () => {
    const prompt = buildJudgeUserPrompt(entries, 'es-ES');
    expect(prompt).toContain('es-ES');
  });

  it('includes all entry keys', () => {
    const prompt = buildJudgeUserPrompt(entries, 'es-ES');
    expect(prompt).toContain('greeting');
    expect(prompt).toContain('farewell');
  });

  it('includes source and translation values', () => {
    const prompt = buildJudgeUserPrompt(entries, 'es-ES');
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('Hola');
  });

  it('describes the expected return format', () => {
    const prompt = buildJudgeUserPrompt(entries, 'es-ES');
    expect(prompt).toContain('verdicts');
    expect(prompt).toContain('flagged');
  });
});

// ── parseVerdicts ─────────────────────────────────────────────────────────────

describe('parseVerdicts', () => {
  const entries = [
    { key: 'a', source: 'Hello', translation: 'Hola' },
    { key: 'b', source: 'World', translation: 'Mundo' },
    { key: 'c', source: 'Test', translation: 'Prueba' }
  ];

  it('parses a well-formed verdict array', () => {
    const parsed = {
      verdicts: [
        { key: 'a', flagged: false, term: null, reasoning: null },
        {
          key: 'b',
          flagged: true,
          term: 'badword',
          reasoning: 'Profanity detected'
        },
        { key: 'c', flagged: false, term: null, reasoning: null }
      ]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      key: 'a',
      flagged: false,
      term: null,
      reasoning: null
    });
    expect(result[1]).toEqual({
      key: 'b',
      flagged: true,
      term: 'badword',
      reasoning: 'Profanity detected'
    });
  });

  it('fills missing keys as unflagged', () => {
    // Judge only returned verdict for key "a"
    const parsed = {
      verdicts: [{ key: 'a', flagged: false, term: null, reasoning: null }]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    expect(result).toHaveLength(3);
    const keys = result.map((v) => v.key).sort();
    expect(keys).toEqual(['a', 'b', 'c']);

    // The missing keys should default to unflagged
    const bVerdict = result.find((v) => v.key === 'b');
    expect(bVerdict).toEqual({
      key: 'b',
      flagged: false,
      term: null,
      reasoning: null
    });
  });

  it('ignores verdicts for unknown keys', () => {
    const parsed = {
      verdicts: [
        { key: 'a', flagged: false },
        { key: 'unknown_key', flagged: true, term: 'bad' }
      ]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    expect(result).toHaveLength(3);
    const keys = result.map((v) => v.key);
    expect(keys).not.toContain('unknown_key');
  });

  it('ignores duplicate keys (keeps first)', () => {
    const parsed = {
      verdicts: [
        { key: 'a', flagged: false, term: null },
        { key: 'a', flagged: true, term: 'dup' }
      ]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    const aVerdicts = result.filter((v) => v.key === 'a');
    expect(aVerdicts).toHaveLength(1);
    expect(aVerdicts[0].flagged).toBe(false); // first wins
  });

  it('returns null for non-object input', () => {
    expect(parseVerdicts('string', entries)).toBeNull();
    expect(parseVerdicts(null, entries)).toBeNull();
    expect(parseVerdicts(42, entries)).toBeNull();
  });

  it('returns null when verdicts is not an array', () => {
    expect(parseVerdicts({ verdicts: 'not_array' }, entries)).toBeNull();
    expect(parseVerdicts({ verdicts: 42 }, entries)).toBeNull();
    expect(parseVerdicts({}, entries)).toBeNull();
  });

  it('skips non-object items in the verdicts array', () => {
    const parsed = {
      verdicts: [
        'not_an_object',
        null,
        { key: 'a', flagged: true, term: 'bad', reasoning: 'offensive' }
      ]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    expect(result).toHaveLength(3);
    const aVerdict = result.find((v) => v.key === 'a');
    assert(aVerdict !== undefined, 'expected to find key a');
    expect(aVerdict.flagged).toBe(true);
  });

  it('handles missing optional fields gracefully', () => {
    const parsed = {
      verdicts: [{ key: 'a', flagged: true }]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    const aVerdict = result.find((v) => v.key === 'a');
    expect(aVerdict).toEqual({
      key: 'a',
      flagged: true,
      term: null,
      reasoning: null
    });
  });

  it('treats missing flagged field as false', () => {
    const parsed = {
      verdicts: [{ key: 'a' }]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    const aVerdict = result.find((v) => v.key === 'a');
    assert(aVerdict !== undefined, 'expected to find key a');
    expect(aVerdict.flagged).toBe(false);
  });

  it('treats non-boolean flagged as false', () => {
    const parsed = {
      verdicts: [{ key: 'a', flagged: 'yes' }]
    };

    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    const aVerdict = result.find((v) => v.key === 'a');
    assert(aVerdict !== undefined, 'expected to find key a');
    expect(aVerdict.flagged).toBe(false);
  });

  it('handles empty entries list', () => {
    const parsed = { verdicts: [] };
    const result = parseVerdicts(parsed, []);
    expect(result).toEqual([]);
  });

  it('handles empty verdicts with non-empty entries', () => {
    const parsed = { verdicts: [] };
    const result = parseVerdicts(parsed, entries);
    assert(result !== null, 'expected non-null result');
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v.flagged).toBe(false);
    }
  });
});

// ── JUDGE_TIMEOUT_MS ──────────────────────────────────────────────────────────

describe('JUDGE_TIMEOUT_MS', () => {
  it('is 120 seconds', () => {
    expect(JUDGE_TIMEOUT_MS).toBe(120_000);
  });
});
