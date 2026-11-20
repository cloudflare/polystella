/** A reply cut off at the output token limit is unusable, so it fails with an explanation instead of a parse error. */
export function outOfTokensError(modelId: string, maxTokens: number): Error {
  return new Error(
    `[polystella] model ran out of output tokens (model="${modelId}", max_tokens=${maxTokens}). Raise the output token limit, translate less text per request, or use a model without long reasoning.`,
  );
}
