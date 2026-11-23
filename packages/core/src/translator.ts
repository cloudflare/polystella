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
  inputTokens?: number | undefined;
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

export function resolveModelId(spec: ModelSpec, locale: string): string {
  if (typeof spec === "string") return spec;
  return spec[locale] ?? spec.default;
}
