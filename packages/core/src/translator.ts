export interface Translator {
  readonly modelId: string;
  translate(systemPrompt: string, userPrompt: string, signal?: AbortSignal | undefined): Promise<string>;
}

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

export type ModelSpec = string | ({ default: string } & Record<string, string>);

export function resolveModelId(spec: ModelSpec, locale: string): string {
  if (typeof spec === "string") return spec;
  return spec[locale] ?? spec.default;
}
