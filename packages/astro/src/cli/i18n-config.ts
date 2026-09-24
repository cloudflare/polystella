/**
 * Shared CLI helpers for loading the consumer project's Astro /
 * PolyStella config. Used by every CLI subcommand that needs the
 * resolved locale set or PolyStella options without pulling in the
 * translation orchestrator.
 *
 * Two public functions:
 *   - `loadAstroI18n(cwd)` — returns the raw `i18n` object from the
 *     Astro config (loaded by core, with Astro's Vite fallback), or
 *     `undefined` if absent. `resolveOptions` validates it.
 *   - `loadPolystellaConfig(cwd)` — default-exports from
 *     `polystella.config.mjs`, used as input to `resolveOptions`.
 *
 * Both keep their error surface narrow: file-not-found becomes a
 * thrown `Error` with the offending path so CLI dispatch can format
 * remediation uniformly.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadAstroConfig } from "@cloudflare/polystella-core/cli/config";

import type { AstroI18nLike } from "../config/options.js";

export async function loadAstroI18n(cwd: string): Promise<AstroI18nLike | undefined> {
  const exported = await loadAstroConfig(cwd);
  if (typeof exported !== "object" || exported === null) {
    return undefined;
  }
  const i18n = (exported as { i18n?: unknown }).i18n;
  if (typeof i18n !== "object" || i18n === null) {
    return undefined;
  }
  return i18n as AstroI18nLike;
}

export async function loadPolystellaConfig(cwd: string): Promise<unknown> {
  const candidatePath = path.resolve(cwd, "polystella.config.mjs");
  try {
    const module = (await import(pathToFileURL(candidatePath).href)) as {
      default: unknown;
    };
    return module.default;
  } catch (err) {
    throw new Error(`failed to load ${candidatePath}: ${(err as Error).message}`);
  }
}
