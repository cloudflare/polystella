import type { Translator } from "@cloudflare/polystella-core";
import {
  createWorkersAIBindingTranslator,
  createWorkersAIHttpTranslator,
  type WorkersAIBindingRun,
  type WorkersAIInput,
} from "@cloudflare/polystella-providers/workers-ai";
import { PluginRouteError, type ContentItem, type LogAccess } from "emdash";

import type { PolystellaEmdashOptions } from "../options.js";

export const MAX_TOKENS = 8192;

export interface PluginRouteDependencies {
  getEnv(): Promise<Record<string, unknown> | undefined>;
  now(): Date;
  fetchImpl?: typeof fetch | undefined;
  findSourceContent?(collection: string, targetId: string, sourceLocale: string): Promise<ContentItem | null>;
}

export function createTranslator(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  modelId: string,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
): Translator {
  const provider = options.provider;
  if (provider.kind === "workers-ai-binding") {
    const binding = env?.[provider.binding];
    if (!isWorkersAIBinding(binding)) {
      log.error("PolyStella Workers AI binding is unavailable", { binding: provider.binding });
      throw new PluginRouteError("AI_BINDING_UNAVAILABLE", "PolyStella's Workers AI binding is unavailable", 503);
    }
    return createWorkersAIBindingTranslator({
      modelId,
      maxTokens: provider.maxTokens ?? MAX_TOKENS,
      run: workersRun(binding),
    });
  }

  const accountId = environmentCredential(env, provider.accountIdEnv);
  const apiToken = environmentCredential(env, provider.apiTokenEnv);
  if (accountId === undefined || apiToken === undefined) {
    log.error("PolyStella Workers AI HTTP credentials are unavailable", {
      accountIdEnv: provider.accountIdEnv,
      apiTokenEnv: provider.apiTokenEnv,
    });
    throw new PluginRouteError("AI_CREDENTIALS_UNAVAILABLE", "PolyStella's Workers AI credentials are unavailable", 503);
  }
  return createWorkersAIHttpTranslator({
    accountId,
    apiToken,
    modelId,
    maxTokens: provider.maxTokens ?? MAX_TOKENS,
    ...(provider.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
    ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
  });
}

export function environmentCredential(env: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = env?.[name];
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : undefined;
}

function workersRun(binding: WorkersAIBinding): WorkersAIBindingRun {
  return async (modelId, input) => await binding.run(modelId, input);
}

interface WorkersAIBinding {
  run(modelId: string, input: WorkersAIInput): unknown;
}

function isWorkersAIBinding(value: unknown): value is WorkersAIBinding {
  return typeof value === "object" && value !== null && "run" in value && typeof value.run === "function";
}
