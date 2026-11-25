import type { Translator } from "@cloudflare/polystella-core";
import {
  createWorkersAIBindingTranslator,
  createWorkersAIHttpTranslator,
  type WorkersAIBindingRun,
  type WorkersAIInput,
  workersAIParamsForLocale,
} from "@cloudflare/polystella-core/providers/workers-ai";
import { PluginRouteError, type LogAccess } from "emdash";

import type { PolystellaEmdashOptions } from "../options.js";
import { isRecord } from "./validators.js";

export const MAX_TOKENS = 8192;
const REQUEST_TIMEOUT_MS = 200_000;

export interface PluginRouteDependencies {
  getEnv(): Promise<Record<string, unknown> | undefined>;
  now(): Date;
  fetchImpl?: typeof fetch | undefined;
  /** Astro locale code → content locale path. Defaults to EmDash's i18n config. */
  localeAliases?: (() => Record<string, string>) | undefined;
}

export function createTranslator(
  options: PolystellaEmdashOptions,
  env: Record<string, unknown> | undefined,
  modelId: string,
  locale: string,
  log: LogAccess,
  dependencies: PluginRouteDependencies,
  maxTokens: number = options.provider.maxTokens ?? MAX_TOKENS,
  /** The admin's thinking choice for this model; its keys win over `models.params` and the code default. */
  thinkingParams?: Readonly<Record<string, unknown>> | undefined,
): Translator {
  const provider = options.provider;
  const baseParams = workersAIParamsForLocale(options.models.params?.[modelId], options.models.defaults, locale, modelId);
  const params = thinkingParams === undefined ? baseParams : withThinking(baseParams, thinkingParams);
  if (provider.kind === "workers-ai-binding") {
    const binding = env?.[provider.binding];
    if (!isWorkersAIBinding(binding)) {
      log.error("PolyStella Workers AI binding is unavailable", { binding: provider.binding });
      throw new PluginRouteError("AI_BINDING_UNAVAILABLE", "PolyStella's Workers AI binding is unavailable", 503);
    }
    return createWorkersAIBindingTranslator({
      modelId,
      maxTokens,
      params,
      timeoutMs: provider.timeoutMs ?? REQUEST_TIMEOUT_MS,
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
    maxTokens,
    params,
    timeoutMs: provider.timeoutMs ?? REQUEST_TIMEOUT_MS,
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

/** Layers the admin's thinking input over `models.params`, so the thinking switch is set once, by the admin. */
export function withThinking(
  base: Readonly<Record<string, unknown>> | undefined,
  thinking: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const baseKwargs = isRecord(base?.chat_template_kwargs) ? base.chat_template_kwargs : undefined;
  const thinkingKwargs = isRecord(thinking.chat_template_kwargs) ? thinking.chat_template_kwargs : undefined;
  const merged: Record<string, unknown> = { ...base, ...thinking };
  const kwargs: Record<string, unknown> = { ...baseKwargs, ...thinkingKwargs };
  const switchInKwargs = thinkingKwargs !== undefined && Object.hasOwn(thinkingKwargs, "enable_thinking");
  if (Object.hasOwn(thinking, "enable_thinking")) delete kwargs.enable_thinking;
  else if (switchInKwargs) delete merged.enable_thinking;
  else if (thinking.reasoning_effort !== "none") {
    // An effort only works with thinking on, so the code's "off" yields to it.
    if (merged.enable_thinking === false) delete merged.enable_thinking;
    if (kwargs.enable_thinking === false) delete kwargs.enable_thinking;
  }
  if (Object.keys(kwargs).length > 0) merged.chat_template_kwargs = kwargs;
  else delete merged.chat_template_kwargs;
  return merged;
}
