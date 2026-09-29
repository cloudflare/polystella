import { getAdapter, type ModelType } from '../llm-adapters';
import { runWorkersAi } from '../workers-ai-http';
import { sanitizeJsonResponse } from '../validation-utils';
import { withTimeout } from '../utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JudgeVerdict {
  key: string;
  flagged: boolean;
  /** The specific offending term, if flagged */
  term?: string | null;
  /** Brief explanation of the flag */
  reasoning?: string | null;
}

export type JudgeResult =
  { ok: true; verdicts: JudgeVerdict[] } | { ok: false; error: string };

export interface JudgeCallMeta {
  judgeModel: ModelType;
  translatorModel: ModelType;
  locale: string;
  keysEvaluated: number;
  keysFlagged: number;
  flaggedKeys: Array<{
    key: string;
    term?: string | null;
    reasoning?: string | null;
  }>;
  latencyMs: number;
  error?: string;
}

// ── Model pairing ─────────────────────────────────────────────────────────────

/**
 * Static mapping: translator model -> judge model.
 * The judge MUST be a different model from the translator to reduce
 * correlated errors.
 */
const JUDGE_MODEL_MAP: Record<ModelType, ModelType> = {
  kimi2_5: 'qwen',
  qwen: 'gpt',
  gpt: 'qwen',
  glm: 'qwen',
  llama: 'qwen'
};

export function getJudgeModel(translatorModel: ModelType): ModelType {
  return JUDGE_MODEL_MAP[translatorModel] ?? 'llama';
}

// ── Prompt construction ───────────────────────────────────────────────────────

interface JudgeEntry {
  key: string;
  source: string;
  translation: string;
}

const JUDGE_SYSTEM_PROMPT = `You are a content safety judge for software UI translations. Your ONLY job is to detect bad words, profanity, slurs, crude language, and offensive terms in translated text.

Rules:
- Flag translations containing profanity, slurs, vulgar language, sexual content, or violent threats
- Do NOT flag technical terms: kill, abort, crash, hang, terminate, execute, master, slave, daemon, dump, fork, pipe, socket, thread are legitimate software terms
- Do NOT flag translations for being awkward, unnatural, or low quality — that is not your concern
- Consider the source text for context — a translation of "kill the process" should not be flagged
- Consider locale-specific norms for the target language
- When in doubt, do NOT flag — only flag when you are confident the term is genuinely offensive

Return valid JSON only. No explanatory text before or after the JSON.`;

function buildJudgeUserPrompt(entries: JudgeEntry[], locale: string): string {
  return `Target locale: ${locale}

Evaluate these translations for bad words, profanity, slurs, or offensive language:

${JSON.stringify(entries, null, 2)}

Return format (valid JSON only):
{"verdicts":[{"key":"...","flagged":true or false,"term":"offending term or null","reasoning":"brief explanation or null"}]}`;
}

// ── Judge call ────────────────────────────────────────────────────────────────

const JUDGE_TIMEOUT_MS = 120_000;

export async function callJudge(
  env: { AI: Ai },
  entries: JudgeEntry[],
  locale: string,
  translatorModel: ModelType
): Promise<{ result: JudgeResult; meta: JudgeCallMeta }> {
  const judgeModelName = getJudgeModel(translatorModel);
  const judgeAdapter = getAdapter(judgeModelName);
  const startTime = Date.now();

  const baseMeta: Omit<
    JudgeCallMeta,
    'latencyMs' | 'keysFlagged' | 'flaggedKeys' | 'error'
  > = {
    judgeModel: judgeModelName,
    translatorModel,
    locale,
    keysEvaluated: entries.length
  };

  try {
    // Build the judge input using the adapter's message format.
    // We bypass the adapter's formatInput (which injects translation-specific
    // prompts) and directly construct messages for the judge task.
    const messages = [
      { role: 'system' as const, content: JUDGE_SYSTEM_PROMPT },
      { role: 'user' as const, content: buildJudgeUserPrompt(entries, locale) }
    ];

    const input: Record<string, unknown> = {
      messages,
      temperature: 0,
      max_tokens: 4096
    };

    if (judgeModelName === 'llama') {
      input.response_format = { type: 'json_object' };
    }

    const modelId = String(judgeAdapter.modelId);
    const response = await withTimeout(
      runWorkersAi(env, modelId, input),
      JUDGE_TIMEOUT_MS,
      `Judge LLM timed out after ${JUDGE_TIMEOUT_MS}ms`
    );

    let rawText = judgeAdapter.extractResponse(response);
    if (!rawText) {
      const latencyMs = Date.now() - startTime;
      return {
        result: { ok: false, error: 'Judge returned empty response' },
        meta: {
          ...baseMeta,
          keysFlagged: 0,
          flaggedKeys: [],
          latencyMs,
          error: 'empty_response'
        }
      };
    }

    // Sanitize
    rawText = sanitizeJsonResponse(rawText);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const latencyMs = Date.now() - startTime;
      return {
        result: {
          ok: false,
          error: `Judge response is not valid JSON: ${rawText.slice(0, 200)}`
        },
        meta: {
          ...baseMeta,
          keysFlagged: 0,
          flaggedKeys: [],
          latencyMs,
          error: 'json_parse_failed'
        }
      };
    }

    // Validate the parsed structure
    const verdicts = parseVerdicts(parsed, entries);
    if (!verdicts) {
      const latencyMs = Date.now() - startTime;
      return {
        result: {
          ok: false,
          error: `Judge response has unexpected shape: ${rawText.slice(0, 200)}`
        },
        meta: {
          ...baseMeta,
          keysFlagged: 0,
          flaggedKeys: [],
          latencyMs,
          error: 'malformed_verdicts'
        }
      };
    }

    const flaggedKeys = verdicts
      .filter((v) => v.flagged)
      .map((v) => ({ key: v.key, term: v.term, reasoning: v.reasoning }));

    const latencyMs = Date.now() - startTime;
    return {
      result: { ok: true, verdicts },
      meta: {
        ...baseMeta,
        keysFlagged: flaggedKeys.length,
        flaggedKeys,
        latencyMs
      }
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMessage =
      err instanceof Error ? err.message : 'Unknown judge error';
    return {
      result: { ok: false, error: errorMessage },
      meta: {
        ...baseMeta,
        keysFlagged: 0,
        flaggedKeys: [],
        latencyMs,
        error: errorMessage
      }
    };
  }
}

// ── Response parsing ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVerdicts(
  parsed: unknown,
  expectedEntries: JudgeEntry[]
): JudgeVerdict[] | null {
  if (!isRecord(parsed)) return null;

  const rawVerdicts = parsed.verdicts;
  if (!Array.isArray(rawVerdicts)) return null;

  const expectedKeys = new Set(expectedEntries.map((e) => e.key));
  const seen = new Set<string>();
  const verdicts: JudgeVerdict[] = [];

  for (const item of rawVerdicts) {
    if (!isRecord(item)) continue;

    const key = typeof item.key === 'string' ? item.key : null;
    if (!key || !expectedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);

    verdicts.push({
      key,
      flagged: item.flagged === true,
      term: typeof item.term === 'string' ? item.term : null,
      reasoning: typeof item.reasoning === 'string' ? item.reasoning : null
    });
  }

  // Fill in missing keys as unflagged (judge may have omitted clean entries)
  for (const entry of expectedEntries) {
    if (!seen.has(entry.key)) {
      verdicts.push({
        key: entry.key,
        flagged: false,
        term: null,
        reasoning: null
      });
    }
  }

  return verdicts;
}

// ── Exports for testing ───────────────────────────────────────────────────────

export const __testing = {
  JUDGE_MODEL_MAP,
  JUDGE_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
  parseVerdicts,
  JUDGE_TIMEOUT_MS
};
