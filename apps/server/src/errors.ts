/**
 * Structured error types for translation operations.
 * Used to classify errors in logs and observability spans.
 */
export const ErrorType = {
  /** Request body failed schema validation */
  INPUT_VALIDATION: 'input_validation',
  /** Input text exceeds the maximum token limit */
  TOKEN_LIMIT_EXCEEDED: 'token_limit_exceeded',
  /** LLM returned an empty or null response */
  LLM_EMPTY_RESPONSE: 'llm_empty_response',
  /** LLM response is not valid JSON when JSON was expected */
  LLM_MALFORMED_JSON: 'llm_malformed_json',
  /** Translated text has missing or mismatched placeholders */
  PLACEHOLDER_MISMATCH: 'placeholder_mismatch',
  /** A key from the source JSON is missing in the LLM translation */
  MISSING_TRANSLATION_KEY: 'missing_translation_key',
  /** The LLM API call threw an exception */
  LLM_CALL_FAILED: 'llm_call_failed',
  /** All retry attempts exhausted without a valid translation */
  RETRY_EXHAUSTED: 'retry_exhausted',
  /** Translated text matched an entry in the content-guardrail wordlist */
  CONTENT_GUARDRAIL_FLAGGED: 'content_guardrail_flagged'
} as const;

export type ErrorType = (typeof ErrorType)[keyof typeof ErrorType];
