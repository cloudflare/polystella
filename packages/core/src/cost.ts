import type { ProviderResponseInfo } from "./translator.js";

/** A model's list price in USD per million tokens. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** For input tokens the provider served from its prompt cache. Default: `inputPerMillion`. */
  cachedInputPerMillion?: number | undefined;
}

/** Token counts summed over model calls. `inputTokens` includes `cachedInputTokens`; `outputTokens` includes `reasoningTokens`. */
export interface TokenUsage {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Calls whose reply reported no token counts, such as timeouts. Their cost is unknown. */
  unreportedCalls: number;
}

export function emptyTokenUsage(): TokenUsage {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, unreportedCalls: 0 };
}

/** Adds one model call; `info` is what the provider reported, or `undefined` when it reported nothing. */
export function addTokenUsage(usage: TokenUsage, info: ProviderResponseInfo | undefined): void {
  usage.calls += 1;
  if (info?.inputTokens === undefined || info.outputTokens === undefined) {
    usage.unreportedCalls += 1;
    return;
  }
  usage.inputTokens += info.inputTokens;
  usage.cachedInputTokens += Math.min(info.cachedInputTokens ?? 0, info.inputTokens);
  usage.outputTokens += info.outputTokens;
  usage.reasoningTokens += info.reasoningTokens ?? 0;
}

export function mergeTokenUsage(into: TokenUsage, from: TokenUsage): void {
  into.calls += from.calls;
  into.inputTokens += from.inputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.outputTokens += from.outputTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.unreportedCalls += from.unreportedCalls;
}

/** List-price estimate in USD. Not an invoice: free allocations, discounts, and calls without token counts are left out. */
export function estimateCostUsd(usage: Pick<TokenUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">, price: ModelPrice): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const cachedPrice = price.cachedInputPerMillion ?? price.inputPerMillion;
  return (
    ((usage.inputTokens - cached) * price.inputPerMillion + cached * cachedPrice + usage.outputTokens * price.outputPerMillion) / 1_000_000
  );
}

/** Why `value` is not a usable `ModelPrice`, or `undefined` when it is. */
export function modelPriceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
  for (const key of Object.keys(value)) {
    if (key !== "inputPerMillion" && key !== "outputPerMillion" && key !== "cachedInputPerMillion") return `has unknown key "${key}"`;
  }
  for (const key of ["inputPerMillion", "outputPerMillion", "cachedInputPerMillion"] as const) {
    const price: unknown = Reflect.get(value, key);
    if (price === undefined && key === "cachedInputPerMillion") continue;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return `${key} must be a number of USD, 0 or more`;
  }
  return undefined;
}

export type ModelPriceLookup = (modelId: string) => Promise<ModelPrice | undefined>;

/**
 * Memoised price lookup: `prices[modelId]` first, then `fallback` (such as the Workers AI catalog). Never throws: a
 * failed fallback resolves `undefined` for the life of the lookup and is reported once through `onError`.
 * It shares pending lookups, so on workerd keep one per request: awaiting another request's I/O there can hang.
 */
export function createModelPriceLookup(options: {
  prices?: Readonly<Record<string, ModelPrice>> | undefined;
  fallback?: ModelPriceLookup | undefined;
  onError?: ((modelId: string, error: unknown) => void) | undefined;
}): ModelPriceLookup {
  const found = new Map<string, Promise<ModelPrice | undefined>>();
  return (modelId) => {
    const { prices } = options;
    if (prices !== undefined && Object.hasOwn(prices, modelId)) return Promise.resolve(prices[modelId]);
    const { fallback } = options;
    if (fallback === undefined) return Promise.resolve(undefined);
    let price = found.get(modelId);
    if (price === undefined) {
      price = fallback(modelId).catch((error: unknown) => {
        options.onError?.(modelId, error);
        return undefined;
      });
      found.set(modelId, price);
    }
    return price;
  };
}

export interface UsageSummary {
  usage: TokenUsage;
  /** Summed over the priced models; `undefined` when none had a price. */
  estimatedCostUsd: number | undefined;
  /** Models that used tokens but have no price, so `estimatedCostUsd` leaves them out. */
  unpricedModels: string[];
}

export async function summarizeUsage(byModel: ReadonlyMap<string, TokenUsage>, lookup: ModelPriceLookup): Promise<UsageSummary> {
  const usage = emptyTokenUsage();
  let estimatedCostUsd: number | undefined;
  const unpricedModels: string[] = [];
  for (const [modelId, modelUsage] of byModel) {
    mergeTokenUsage(usage, modelUsage);
    if (modelUsage.calls === modelUsage.unreportedCalls) continue;
    const price = await lookup(modelId);
    if (price === undefined) unpricedModels.push(modelId);
    else estimatedCostUsd = (estimatedCostUsd ?? 0) + estimateCostUsd(modelUsage, price);
  }
  return { usage, estimatedCostUsd, unpricedModels };
}

/**
 * One line for logs, such as "12 model calls, 34,000 input / 5,600 output tokens, estimated cost $0.0123 (tokens ×
 * list price)".
 */
export function formatUsageSummary({ usage, estimatedCostUsd, unpricedModels }: UsageSummary): string {
  const count = (value: number) => value.toLocaleString("en-US");
  const parts = [
    `${count(usage.calls)} model call${usage.calls === 1 ? "" : "s"}`,
    `${count(usage.inputTokens)} input / ${count(usage.outputTokens)} output tokens`,
  ];
  if (estimatedCostUsd !== undefined) parts.push(`estimated cost $${estimatedCostUsd.toFixed(4)} (tokens × list price)`);
  if (unpricedModels.length > 0) parts.push(`no price for ${unpricedModels.join(", ")} (left out of the estimate)`);
  if (usage.unreportedCalls > 0) parts.push(`${count(usage.unreportedCalls)} without token counts`);
  return parts.join(", ");
}

/** The usage for `modelId` in `byModel`, added empty on first use. */
export function usageFor(byModel: Map<string, TokenUsage>, modelId: string): TokenUsage {
  let usage = byModel.get(modelId);
  if (usage === undefined) {
    usage = emptyTokenUsage();
    byModel.set(modelId, usage);
  }
  return usage;
}
