/** Provider-independent model transport used by the translation pipeline. */
export interface Translator {
  readonly modelId: string;
  /** `onResponse`, when given, receives what the provider reported about the reply, before the reply is checked. */
  translate(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal | undefined,
    onResponse?: ((info: ProviderResponseInfo) => void) | undefined,
  ): Promise<string>;
}

/** What a provider reported about one reply, for diagnostics. Fields the provider doesn't report are absent. */
export interface ProviderResponseInfo {
  finishReason?: string | undefined;
  /** Length of the model's separate reasoning text, for reasoning models that return one. */
  reasoningCharacters?: number | undefined;
  /** All input tokens, cached ones included. */
  inputTokens?: number | undefined;
  /** The part of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number | undefined;
  /** All output tokens, reasoning included. */
  outputTokens?: number | undefined;
  /** Output tokens spent on reasoning, when the provider counts them separately. */
  reasoningTokens?: number | undefined;
}

/** Provider failure that retries cannot resolve, such as invalid credentials. */
export class PermanentProviderError extends Error {
  readonly _tag = "PermanentProviderError" as const;

  constructor(message: string) {
    super(message);
    this.name = "PermanentProviderError";
  }
}

export function isPermanentProviderError(error: unknown): error is PermanentProviderError {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === "PermanentProviderError";
}

/** One model for all locales or a default model with locale overrides. */
export type ModelSpec = string | ({ default: string } & Record<string, string>);

/** A model id, or a model id with how the locales using it call it. `enable_thinking` is read by Workers AI translators. */
export type ModelChoice = string | { model: string; enable_thinking?: boolean | undefined };

/** Like `ModelSpec`, but each locale's entry may be a `ModelChoice` object. */
export type ModelChoiceSpec = string | ({ default: ModelChoice } & Record<string, ModelChoice>);

export function resolveModelId(spec: ModelChoiceSpec, locale: string): string {
  return resolveModelChoice(spec, locale).model;
}

export function resolveModelChoice(spec: ModelChoiceSpec, locale: string): { model: string; enable_thinking?: boolean | undefined } {
  const choice = typeof spec === "string" ? spec : (spec[locale] ?? spec.default);
  return typeof choice === "string" ? { model: choice } : choice;
}
