import type { PolystellaEmdashOptions } from "./options.js";
import { environmentCredential, type PluginRouteDependencies } from "./routes/provider.js";

/** Efforts a model accepts, each mapped to the input fields that select it. `"none"` turns thinking off. */
export type ReasoningCapability = ReadonlyMap<string, Readonly<Record<string, unknown>>>;

const CATALOG_TIMEOUT_MS = 5000;
const FAILURE_RETRY_MS = 60_000;

// Keyed by provider kind and model only: the Workers AI catalog is the same for every account. Only settled lookups
// are kept: on workerd a request that awaits a promise another request's I/O settles can hang.
const capabilities = new Map<string, { result: { capability: ReasoningCapability | null } | { error: unknown }; expiresAt: number }>();

/**
 * What the model accepts for thinking, from `models.reasoningInput` or the Workers AI catalog.
 * `null` when it has no switch. Throws when the catalog can't be read; a failure is retried after a minute.
 */
export async function reasoningCapability(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  modelId: string,
  dependencies: PluginRouteDependencies,
): Promise<ReasoningCapability | null> {
  const custom = options.models.reasoningInput;
  if (custom !== undefined && Object.hasOwn(custom, modelId)) return new Map(Object.entries(custom[modelId] ?? {}));
  const key = `${options.provider.kind}:${modelId}`;
  let cached = capabilities.get(key);
  if (cached === undefined || cached.expiresAt <= Date.now()) {
    try {
      const entries = await withTimeout(catalogEntries(options, env, modelId, dependencies), CATALOG_TIMEOUT_MS);
      const capability = parseCapability(entries.find((item) => isRecord(item) && item.name === modelId));
      cached = { result: { capability }, expiresAt: Number.POSITIVE_INFINITY };
    } catch (error) {
      cached = { result: { error }, expiresAt: Date.now() + FAILURE_RETRY_MS };
    }
    capabilities.set(key, cached);
  }
  if ("error" in cached.result) throw cached.result.error;
  return cached.result.capability;
}

/** Test hook: forget cached catalog lookups. */
export function clearReasoningCapabilities(): void {
  capabilities.clear();
}

async function catalogEntries(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  modelId: string,
  dependencies: PluginRouteDependencies,
): Promise<unknown[]> {
  const provider = options.provider;
  if (provider.kind === "workers-ai-binding") {
    const binding = env?.[provider.binding];
    if (!isRecord(binding) || typeof binding.models !== "function") throw new Error("the Workers AI binding cannot list models");
    const result: unknown = await binding.models({ search: modelId });
    if (!Array.isArray(result)) throw new Error("the Workers AI binding returned an unexpected model list");
    return result;
  }
  // The token may belong to a gateway or another host, so it is never sent to the Cloudflare API.
  if (provider.endpoint !== undefined) return [];
  const accountId = environmentCredential(env, provider.accountIdEnv);
  const apiToken = environmentCredential(env, provider.apiTokenEnv);
  if (accountId === undefined || apiToken === undefined) throw new Error("Workers AI credentials are unavailable");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?${new URLSearchParams({ search: modelId })}`;
  const response = await (dependencies.fetchImpl ?? fetch)(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the Workers AI model catalog returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.result)) throw new Error("the Workers AI model catalog returned an unexpected response");
  return body.result;
}

/** Reads the catalog's `reasoning_effort` property: listed efforts, or a plain on/off switch when thinking isn't mandatory. */
export function parseCapability(entry: unknown): ReasoningCapability | null {
  const properties = isRecord(entry) && Array.isArray(entry.properties) ? entry.properties : [];
  const property: unknown = properties.find((item) => isRecord(item) && item.property_id === "reasoning_effort");
  const value = isRecord(property) ? parseJsonString(property.value) : undefined;
  if (!isRecord(value)) return null;
  const capability = new Map<string, Readonly<Record<string, unknown>>>();
  if (Array.isArray(value.supported_efforts)) {
    for (const effort of value.supported_efforts) {
      if (typeof effort === "string" && effort.length > 0) capability.set(effort, { reasoning_effort: effort });
    }
  }
  if (value.mandatory === false && !capability.has("none")) {
    capability.set("none", { enable_thinking: false });
    if (capability.size === 1) capability.set("on", { enable_thinking: true });
  }
  return capability.size === 0 ? null : capability;
}

/** Catalog property values may arrive as JSON text. */
function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const signal = AbortSignal.timeout(milliseconds);
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("the Workers AI model catalog timed out")), { once: true });
    promise.then(resolve, reject);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
