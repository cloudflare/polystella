import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  buildSystemContext,
  buildUserInput,
  GUARDRAIL_RETRY_REINFORCEMENT
} from './prompt-utils';
import { TERMINOLOGY_MAP } from './terminology';
import { DO_NOT_TRANSLATE_TERMS } from '../locales/utils';

beforeEach(() => {
  TERMINOLOGY_MAP['zh-TW'] = {
    Cloudflare: 'Synthetic Cloudflare',
    'API endpoints': 'Synthetic API endpoints',
    'DDoS attack': 'Synthetic DDoS attack',
    DNS: 'Synthetic DNS',
    Firewall: 'Synthetic Firewall',
    'Load Balancing': 'Synthetic Load Balancing',
    'SSL/TLS': 'Synthetic SSL/TLS',
    'data center;Data center': 'Synthetic data center',
    'Cloudflare Registrar': 'Synthetic registrar'
  };
  DO_NOT_TRANSLATE_TERMS.push(
    'Cache',
    'Cloudflare',
    'Workers',
    'WordPress',
    'Pro',
    'Magic WAN',
    'WAF'
  );
});

afterEach(() => {
  delete TERMINOLOGY_MAP['zh-TW'];
  DO_NOT_TRANSLATE_TERMS.length = 0;
});

function getTerminologySection(prompt: string): string {
  const start = prompt.indexOf('TERMINOLOGY REFERENCE:');
  if (start === -1) {
    return '';
  }

  const end = prompt.indexOf('LANGUAGE STYLE GUIDE:', start);
  return end === -1 ? prompt.slice(start) : prompt.slice(start, end);
}

function getDoNotTranslateLine(prompt: string): string {
  return (
    prompt
      .split('\n')
      .find((line) => line.includes('- Product names in source:')) ?? ''
  );
}

describe('buildSystemContext terminology selection', () => {
  it('injects only relevant glossary terms plus the core always-include set', () => {
    const sourceText =
      'Enable Firewall to reduce DDoS attack impact in this data center.';
    const { prompt, meta } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    const terminologySection = getTerminologySection(prompt);

    expect(meta.hasTerminology).toBe(true);
    expect(meta.terminologyEntryCount).toBeGreaterThan(0);
    expect(meta.terminologyEntryCount).toBeLessThan(
      Object.keys(TERMINOLOGY_MAP['zh-TW']).length
    );
    expect(terminologySection).toContain('"Firewall":');
    expect(terminologySection).toContain('"DDoS attack":');
    expect(terminologySection).toContain('"data center;Data center":');
    expect(terminologySection).not.toContain('"Cloudflare Registrar":');
  });

  it('matches glossary terms from JSON values and ignores JSON keys', () => {
    const sourceText = JSON.stringify({
      Smartphone: 'Enable Firewall and Cache for this endpoint.'
    });
    const { prompt } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    const terminologySection = getTerminologySection(prompt);
    const doNotTranslateLine = getDoNotTranslateLine(prompt);

    expect(terminologySection).toContain('"Firewall":');
    // "Cache" is now in the DO_NOT_TRANSLATE list, not the terminology glossary
    expect(doNotTranslateLine).toContain('"Cache"');
    expect(terminologySection).not.toContain('"Cache":');
    expect(terminologySection).not.toContain('"Smartphone":');
  });

  it('injects only do-not-translate terms found in source text', () => {
    const sourceText =
      'Cloudflare Workers integrates with WordPress on Pro plan.';
    const { prompt } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    const doNotTranslateLine = getDoNotTranslateLine(prompt);

    expect(doNotTranslateLine).toContain('"Cloudflare"');
    expect(doNotTranslateLine).toContain('"Workers"');
    expect(doNotTranslateLine).toContain('"WordPress"');
    expect(doNotTranslateLine).toContain('"Pro"');
    expect(doNotTranslateLine).not.toContain('"Magic WAN"');
  });

  it('matches do-not-translate terms from JSON values and ignores JSON keys', () => {
    const sourceText = JSON.stringify({
      Cloudflare: 'Enable Workers and WAF on this route.'
    });
    const { prompt } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    const doNotTranslateLine = getDoNotTranslateLine(prompt);

    expect(doNotTranslateLine).toContain('"Workers"');
    expect(doNotTranslateLine).toContain('"WAF"');
    expect(doNotTranslateLine).not.toContain('"Cloudflare"');
  });

  it('handles deeply nested JSON values without recursive stack growth', () => {
    const depth = 200;
    const nestedJson = { value: 'Enable Firewall' } as Record<string, unknown>;
    let current = nestedJson;

    for (let index = 0; index < depth; index += 1) {
      current.child = { value: current.value };
      delete current.value;
      current = current.child as Record<string, unknown>;
    }

    current.value = 'Enable Firewall';
    const sourceText = JSON.stringify(nestedJson);

    const { prompt } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    const terminologySection = getTerminologySection(prompt);

    expect(terminologySection).toContain('"Firewall":');
  });
});

describe('buildSystemContext retry-prompt escalation', () => {
  const baseArgs = {
    sourceLocale: 'en-US',
    targetLocale: 'es-ES',
    sourceText: 'Hello world'
  };

  it('omits reinforcement when retryContext is undefined (first attempt)', () => {
    const { prompt } = buildSystemContext(baseArgs);
    expect(prompt).not.toContain('CONTENT GUARDRAIL RETRY REINFORCEMENT');
    expect(prompt).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    expect(prompt).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
  });

  it('omits reinforcement for placeholder retry reason (reserved for future use)', () => {
    const { prompt } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'placeholder', previousFailureCount: 1 }
    });
    expect(prompt).not.toContain('CONTENT GUARDRAIL RETRY REINFORCEMENT');
  });

  it('includes tier 1 reinforcement at previousFailureCount=1', () => {
    const { prompt } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'content_guardrail', previousFailureCount: 1 }
    });
    expect(prompt).toContain('CONTENT GUARDRAIL RETRY REINFORCEMENT');
    expect(prompt).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    // Tier 2 does NOT stack on a first-flag retry.
    expect(prompt).not.toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
  });

  it('stacks tier 2 on top of tier 1 at previousFailureCount=2', () => {
    const { prompt } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'content_guardrail', previousFailureCount: 2 }
    });
    expect(prompt).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    expect(prompt).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
  });

  it('stacks tier 2 for any previousFailureCount >= 2', () => {
    const { prompt: p3 } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'content_guardrail', previousFailureCount: 3 }
    });
    expect(p3).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier1);
    expect(p3).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);

    const { prompt: p10 } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'content_guardrail', previousFailureCount: 10 }
    });
    expect(p10).toContain(GUARDRAIL_RETRY_REINFORCEMENT.tier2);
  });

  it('reinforcement is appended after the core rules block', () => {
    // Append-last positioning keeps the reinforcement close to the user
    // turn and less diluted by intermediate tokens. Using the unconditional
    // "PRESERVE EXACTLY" landmark (present regardless of terminology/style
    // guide availability in the test env).
    const { prompt } = buildSystemContext({
      ...baseArgs,
      retryContext: { reason: 'content_guardrail', previousFailureCount: 1 }
    });
    const coreRulesIdx = prompt.indexOf('PRESERVE EXACTLY');
    const reinforcementIdx = prompt.indexOf(
      'CONTENT GUARDRAIL RETRY REINFORCEMENT'
    );
    expect(coreRulesIdx).toBeGreaterThanOrEqual(0);
    expect(reinforcementIdx).toBeGreaterThan(coreRulesIdx);
  });
});

describe('buildUserInput sourceLocale injection', () => {
  it('injects "from {sourceLocale} to {targetLocale}" in plain-text branch', () => {
    const userInput = buildUserInput({
      text: 'Hello world',
      sourceLocale: 'ja-JP',
      targetLocale: 'en-US'
    });
    expect(userInput).toContain('from ja-JP to en-US');
  });

  it('injects "from {sourceLocale} to {targetLocale}" in JSON branch', () => {
    const userInput = buildUserInput({
      text: '{"greeting":"Hello"}',
      sourceLocale: 'ja-JP',
      targetLocale: 'en-US'
    });
    expect(userInput).toContain('from ja-JP to en-US');
    // JSON branch keeps its existing structural rules
    expect(userInput).toContain('Keep ALL 1 keys');
  });

  it('uses sourceLocale=en-US when called with the default value', () => {
    // The handler resolves omitted sourceLocale to en-US before this is
    // called; this test pins the formatting so any change to the wording
    // (e.g. "from English") gets caught.
    const userInput = buildUserInput({
      text: 'Hello',
      sourceLocale: 'en-US',
      targetLocale: 'fr-FR'
    });
    expect(userInput).toContain('from en-US to fr-FR');
  });
});

describe('buildSystemContext sourceLocale handling', () => {
  it('mentions both source and target in the system prompt', () => {
    const { prompt } = buildSystemContext({
      sourceLocale: 'ja-JP',
      targetLocale: 'en-US',
      sourceText: 'こんにちは'
    });
    expect(prompt).toContain('translating from ja-JP to en-US');
  });

  it('skips the terminology section when sourceLocale is non-English', () => {
    // Source corpus contains terminology terms ("Firewall", "DDoS attack")
    // that WOULD normally be injected for an English source. When the source
    // is non-English we skip the entire glossary because the keys are
    // English-language strings that won't match a non-English corpus.
    const sourceText =
      'Enable Firewall to reduce DDoS attack impact in this data center.';
    const { prompt, meta } = buildSystemContext({
      sourceLocale: 'ja-JP',
      targetLocale: 'en-US',
      sourceText
    });
    expect(meta.hasTerminology).toBe(false);
    expect(meta.terminologyEntryCount).toBe(0);
    expect(prompt).not.toContain('TERMINOLOGY REFERENCE:');
  });

  it('keeps the terminology section when sourceLocale is en-US (backward compatible)', () => {
    const sourceText =
      'Enable Firewall to reduce DDoS attack impact in this data center.';
    const { prompt, meta } = buildSystemContext({
      sourceLocale: 'en-US',
      targetLocale: 'zh-TW',
      sourceText
    });
    expect(meta.hasTerminology).toBe(true);
    expect(prompt).toContain('TERMINOLOGY REFERENCE:');
  });

  it('keeps do-not-translate injection regardless of sourceLocale (product names work cross-locale)', () => {
    // Decision: product names like "Cloudflare" are written in English
    // even in non-English source text, so we keep the existing matching.
    const sourceText = 'Bonjour, je veux configurer Cloudflare Workers.';
    const { prompt } = buildSystemContext({
      sourceLocale: 'fr-FR',
      targetLocale: 'en-US',
      sourceText
    });
    const doNotTranslateLine =
      prompt
        .split('\n')
        .find((line) => line.includes('- Product names in source:')) ?? '';
    expect(doNotTranslateLine).toContain('"Cloudflare"');
    expect(doNotTranslateLine).toContain('"Workers"');
  });
});
