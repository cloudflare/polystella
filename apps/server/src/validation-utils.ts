import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import { checkProfanity } from './guardrail';

const encoding = new Tiktoken(cl100k_base);

/**
 * Guardrail operating mode threaded into `validateTranslationEntry`.
 *
 * - `off` — guardrail is not invoked. Behavior identical to pre-guardrail
 *   code.
 * - `shadow` — guardrail runs; flags populate `ValidationResult.guardrail`
 *   for observability but do NOT push errors or affect `success`.
 * - `enforce` — guardrail runs; flags populate `ValidationResult.guardrail`
 *   AND push an error AND set `success: false`, which triggers the existing
 *   per-key retry loop in translate-text.ts.
 */
export const GUARDRAIL_MODES = ['off', 'shadow', 'enforce'] as const;
export type GuardrailMode = (typeof GUARDRAIL_MODES)[number];

/**
 * Runtime type guard for plain-object records keyed by string. Used to
 * safely narrow `unknown` values coming from parsed JSON — rejects arrays
 * (which are also `typeof === 'object'`) and `null`. The predicate return
 * type narrows callers to `Record<string, unknown>` without a blind cast.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Helper function to validate JSON response
export const isValidJSONString = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates that the text does not exceed the maximum token limit
 * @param text - The text to validate
 * @param maxTokens - Maximum allowed tokens (default: 5000)
 * @returns ValidationResult with token count information
 */
export function validateTokenCount(
  text: string,
  maxTokens: number = 5000
): ValidationResult & { tokenCount: number } {
  const errors: string[] = [];

  try {
    const tokens = encoding.encode(text);
    const tokenCount = tokens.length;

    if (tokenCount > maxTokens) {
      errors.push(
        `Token limit exceeded: ${tokenCount} tokens (max: ${maxTokens})`
      );
    }

    return {
      success: !errors.length,
      errors,
      tokenCount
    };
  } catch (error) {
    errors.push(
      `Token counting error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return {
      success: false,
      errors,
      tokenCount: 0
    };
  }
}

/**
 * Metadata about a content-guardrail flag on a specific translation entry.
 * Populated only when the guardrail check flagged the translated text;
 * absent when validation was purely placeholder-related, when the guardrail
 * passed, or when the guardrail was skipped (out-of-scope locale, empty
 * text, or guardrail mode off).
 *
 * Consumed by the translate-text retry loop for Braintrust span logging and
 * for retry-prompt escalation.
 */
export interface GuardrailValidationDetail {
  /**
   * Wordlist entries that matched.
   */
  matches: string[];
  /** Target locale of the translation that was flagged. */
  locale: string;
  /**
   * The specific key (or dotted path for nested structures, e.g.
   * "file.json.key") whose translated value was flagged.
   */
  subKey: string;
  /**
   * The wordlist that was applied, or null if the locale is out of scope
   * for the guardrail. Mirrors `GuardrailResult.wordlistApplied`.
   */
  wordlistApplied: string | null;
}

/**
 * Result type for validation operations
 */
export interface ValidationResult {
  success: boolean;
  errors: string[];
  /**
   * Populated only when the content guardrail check flagged a translation
   * entry. Independent from `success` / `errors`:
   * - In `enforce` mode the guardrail flag also pushes an entry to `errors`
   *   and sets `success: false`.
   * - In `shadow` mode this field may be populated while `success: true`
   *   and `errors` is empty — callers should log but not retry.
   * - Absent entirely when the guardrail did not flag anything.
   */
  guardrail?: GuardrailValidationDetail;
}

/**
 * Extracts placeholders from a string (e.g., {{variable1}}, {{variable2}}, %{variable3})
 * @param text - The text to extract placeholders from
 * @returns Array of placeholder strings in order of appearance
 */
function extractVariablePlaceholders(text: string): string[] {
  const regex = /\{\{[^}]+\}\}|%\{[^}]+\}/g;
  const matches = text.match(regex);
  return matches || [];
}

/**
 * Extracts component template placeholders from a string (e.g., <0>, <1>, </0>, </1>)
 * @param text - The text to extract component placeholders from
 * @returns Array of placeholder strings in order of appearance
 */
function extractComponentPlaceholders(text: string): string[] {
  const regex = /<\/?[0-9]+>/g;
  const matches = text.match(regex);
  return matches || [];
}

// Validate proper nesting by checking that opening tags have corresponding closing tags
function validateComponentPlaceholderNesting(placeholders: string[]) {
  const stack: string[] = [];
  const nestingErrors: string[] = [];

  // Loop over the array of placeholders and add/remove them from expected stack
  for (const placeholder of placeholders) {
    // If we encounter a closing tag, then the last item on the stack must be its opening pair.
    // If the stack is empty or the top of the stack is not the expected opening tag, then we have an error.
    // Else we remove the opening pair and continue
    if (placeholder.startsWith('</')) {
      const tagNumber = placeholder.slice(2, -1);
      const expectedOpening = `<${tagNumber}>`;

      if (stack.length === 0 || stack[stack.length - 1] !== expectedOpening) {
        nestingErrors.push(`error: unmatched closing tag ${placeholder}`);
      } else {
        stack.pop();
      }
    }

    // If we encounter an opnening tag, add it to the stack
    else {
      stack.push(placeholder);
    }
  }

  // Check for unclosed tags
  if (stack.length) {
    nestingErrors.push(`error: unclosed tags: ${stack.join(', ')}`);
  }

  return nestingErrors;
}

/**
 * Validates that component template placeholders are properly paired and nested
 * @param original - The original text with component placeholders
 * @param translated - The translated text with component placeholders
 * @returns ValidationResult indicating if component placeholders are valid
 */
export function validateComponentPlaceholders(
  original: string,
  translated: string
): ValidationResult {
  const errors: string[] = [];

  const originalPlaceholders = extractComponentPlaceholders(original);
  const translatedPlaceholders = extractComponentPlaceholders(translated);

  // Check if placeholder counts match
  if (originalPlaceholders.length !== translatedPlaceholders.length) {
    errors.push(
      `Component placeholder count mismatch: original has ${originalPlaceholders.length}, translated has ${translatedPlaceholders.length}`
    );
  }

  // Validate that all placeholders in original exist in translated
  const missingPlaceholders = originalPlaceholders.filter(
    (placeholder) => !translatedPlaceholders.includes(placeholder)
  );
  if (missingPlaceholders.length > 0) {
    errors.push(
      `Missing component placeholders: ${missingPlaceholders.join(', ')}`
    );
  }

  // Validate nesting for both original and translated
  errors.push(...validateComponentPlaceholderNesting(translatedPlaceholders));

  return {
    success: !errors.length,
    errors
  };
}

/**
 * Validates that placeholders and variables are preserved in the translated output
 * in the same order as the original input
 * @param original - The original text (can be a string or JSON object with string values)
 * @param translated - The translated text (can be a string or JSON object with string values)
 * @returns ValidationResult indicating if placeholders match and any errors found
 */
export function validateVariablePlaceholders(
  original: string,
  translated: string
): ValidationResult {
  const errors: string[] = [];

  const originalPlaceholders = extractVariablePlaceholders(original);
  const translatedPlaceholders = extractVariablePlaceholders(translated);

  // Check if placeholder count matches
  if (originalPlaceholders.length !== translatedPlaceholders.length) {
    errors.push(
      `Placeholder count mismatch: original has ${originalPlaceholders.length}, translated has ${translatedPlaceholders.length}`
    );
  }

  return {
    success: !errors.length,
    errors
  };
}

/**
 * Validates a single translation entry (key-value pair) from the LLM response
 * against the original source. Handles both flat ("key": "value") and
 * nested ("filePath": {"key": "value"}) structures.
 *
 * Validation order per pair:
 *   1. Component placeholder integrity (`<0></0>` style)
 *   2. Variable placeholder integrity (`{{var}}`, `%{var}` styles)
 *   3. Content guardrail wordlist check (gated on `guardrailMode`)
 *
 * Guardrail runs only when placeholder checks pass on a given pair —
 * retrying on a placeholder failure already re-invokes the LLM, so there's
 * no need to also flag content on a known-retrying key.
 *
 * @param originalValue - The original source value. Either a plain string
 *   (flat translation) or a `Record<string, unknown>` (nested translation,
 *   e.g. `{ "common.json": { "welcome": "Hello" } }`). Other shapes are
 *   tolerated as a no-op (produces no pairs to validate).
 * @param translatedValue - The LLM-translated value, expected to mirror
 *   `originalValue`'s shape. Missing sub-keys produce an error entry.
 * @param key - The top-level key name (for error reporting)
 * @param locale - The target locale (for error reporting)
 * @param guardrailMode - How to react to guardrail flags. Required — caller
 *   must explicitly declare intent. Pass `'off'` to disable.
 * @returns ValidationResult; `guardrail` populated when a flag was observed
 *          (in either `shadow` or `enforce` mode).
 */
export function validateTranslationEntry(
  originalValue: unknown,
  translatedValue: unknown,
  key: string,
  locale: string,
  guardrailMode: GuardrailMode
): ValidationResult {
  const errors: string[] = [];
  let guardrailDetail: ValidationResult['guardrail'] | undefined;

  const pairsToValidate: Array<{
    subKey: string;
    source: string;
    translated: string;
  }> = [];

  if (isRecord(originalValue)) {
    const translatedRecord = isRecord(translatedValue)
      ? translatedValue
      : undefined;
    for (const subKey of Object.keys(originalValue)) {
      const src = originalValue[subKey];
      const tgt = translatedRecord?.[subKey];
      if (typeof src === 'string' && typeof tgt === 'string') {
        pairsToValidate.push({
          subKey: `${key}.${subKey}`,
          source: src,
          translated: tgt
        });
      } else if (typeof src === 'string' && !tgt) {
        errors.push(
          `Missing nested translation key - ${key}.${subKey} for locale [${locale}]`
        );
      }
    }
  } else if (typeof originalValue === 'string') {
    if (typeof translatedValue === 'string') {
      pairsToValidate.push({
        subKey: key,
        source: originalValue,
        translated: translatedValue
      });
    } else {
      // The source is a string but the LLM returned a non-string value (or
      // nothing). Flag as a missing translation rather than silently
      // passing — the pre-`unknown` code would have thrown from inside
      // `text.match` when the placeholder validator ran on a non-string.
      errors.push(`Missing translation key - ${key} for locale [${locale}]`);
    }
  }

  for (const { subKey, source, translated } of pairsToValidate) {
    const componentResult = validateComponentPlaceholders(source, translated);
    if (!componentResult.success) {
      errors.push(
        `Component placeholder validation failed for key - ${subKey} for locale [${locale}]`
      );
      break;
    }

    const variableResult = validateVariablePlaceholders(source, translated);
    if (!variableResult.success) {
      errors.push(
        `Variable placeholder validation failed for key - ${subKey} for locale [${locale}]`
      );
      break;
    }

    // Content guardrail (Phase 1: wordlist check).
    // - `off`: skip entirely.
    // - `shadow` / `enforce`: run on first pair that passes placeholders.
    //   Once we've captured a guardrail detail for this entry do not
    //   overwrite it with later pairs — one flag per entry is enough signal.
    if (guardrailMode !== 'off' && !guardrailDetail) {
      const gr = checkProfanity(translated, locale);
      if (!gr.passed && !gr.skipped) {
        guardrailDetail = {
          matches: gr.matches,
          locale,
          subKey,
          wordlistApplied: gr.wordlistApplied
        };
        if (guardrailMode === 'enforce') {
          errors.push(
            `Content guardrail flagged translation for key - ${subKey} for locale [${locale}] (matches: ${gr.matches.length})`
          );
          break;
        }
      }
    }
  }

  return {
    success: errors.length === 0,
    errors,
    ...(guardrailDetail ? { guardrail: guardrailDetail } : {})
  };
}

/**
 * Sanitizes LLM JSON response to fix common issues.
 * Handles: double-encoded JSON, mixed quote styles that break JSON parsing.
 * @param response - Raw LLM response string
 * @returns Sanitized string safe for JSON.parse()
 */
export function sanitizeJsonResponse(response: string): string {
  let result = response.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const codeFenceMatch = result.match(
    /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/
  );
  if (codeFenceMatch) {
    result = codeFenceMatch[1].trim();
  }

  // Handle double-encoded JSON: LLM wrapped response in quotes
  // e.g., "{\n  \"key\": \"value\"}" instead of {\n  "key": "value"}
  if (result.startsWith('"') && result.endsWith('"')) {
    try {
      // First parse unwraps the outer string
      const unwrapped = JSON.parse(result);
      if (typeof unwrapped === 'string') {
        result = unwrapped;
      }
    } catch {
      // If that fails, try stripping quotes and unescaping manually
      result = result
        .slice(1, -1) // Remove outer quotes
        .replace(/\\n/g, '\n') // Unescape newlines
        .replace(/\\"/g, '"'); // Unescape quotes
    }
  }

  // Fix mixed quote patterns that break JSON parsing
  // LLMs often produce: \"word" (escaped ASCII + curly close)
  // This breaks JSON because \" becomes literal " which ends the string

  // Only apply fixes if JSON.parse fails
  try {
    JSON.parse(result);
    return result; // Already valid, don't modify
  } catch {
    // JSON is invalid, try to fix quote issues
  }

  // Fix broken mixed quote patterns: \" + word + typographic close → proper pair
  result = result.replace(/\\?"([^«»\n]{1,50})»/g, '«$1»'); // French
  result = result.replace(/\\?"([^「」\n]{1,50})」/g, '「$1」'); // CJK
  result = result.replace(/\\?"([^"""\n]{1,50})"/g, '"$1"'); // Generic/German

  return result;
}
