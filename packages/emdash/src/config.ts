import type { CatalogGlossaryConfig } from "@cloudflare/polystella-core/cli/config";
import { assertSingleGlossarySource, loadGlossariesWithSources } from "@cloudflare/polystella-core/cli/glossary";

import type { GlossaryDefault } from "./server/options.js";

interface LoadGlossaryDefaultsBase {
  locales: ReadonlyArray<string>;
  signal?: AbortSignal | undefined;
}

export type LoadGlossaryDefaultsOptions =
  | (LoadGlossaryDefaultsBase & Extract<CatalogGlossaryConfig, { file: string }> & { projectRoot: URL })
  | (LoadGlossaryDefaultsBase & Exclude<CatalogGlossaryConfig, { file: string }> & { projectRoot?: URL | undefined });

/** Load structured per-locale YAML defaults while Astro evaluates its config, keeping each file's text for the admin. */
export async function loadGlossaryDefaults(options: LoadGlossaryDefaultsOptions): Promise<Record<string, GlossaryDefault>> {
  assertSingleGlossarySource(options);
  const glossaries =
    options.file !== undefined
      ? await loadGlossariesWithSources({
          config: { locales: options.locales, glossary: { file: options.file } },
          projectRoot: options.projectRoot,
          signal: options.signal,
        })
      : await loadGlossariesWithSources({
          config: { locales: options.locales, glossary: nonFileSource(options) },
          signal: options.signal,
        });
  return Object.fromEntries(
    [...glossaries].map(([locale, { glossary, source }]) => [locale, source === undefined ? glossary : { ...glossary, source }]),
  );
}

function nonFileSource(options: Exclude<LoadGlossaryDefaultsOptions, { file: string }>): Exclude<CatalogGlossaryConfig, { file: string }> {
  if (options.inline !== undefined) return { inline: options.inline };
  if (options.http !== undefined) return { http: options.http };
  return { r2: options.r2 };
}
