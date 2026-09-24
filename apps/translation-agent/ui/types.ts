export interface Locale {
  code: string;
  name: string;
  variant: string;
}

export interface TranslationResponse {
  success: boolean;
  original: string;
  translations: Record<string, unknown>;
  /**
   * Per-locale execution metadata. `meta[locale].model` reports the LLM
   * that actually produced (or last attempted) output for that locale.
   * May differ from the request's `model` when runtime fallback executed.
   * Mirrors locales appearing in `translations`, `partialLocales`, and
   * `errors`. Absent on pre-LLM failure responses (token limit, schema).
   */
  meta?: Record<string, { model: string }>;
  error?: string;
  details?: string;
  /** Locales where some JSON keys failed validation after all retries */
  partialLocales?: Array<{ locale: string; error: string }>;
  /** Locales that failed entirely */
  errors?: Array<{ locale: string; error: string }>;
}
