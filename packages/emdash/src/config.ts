import type { Glossary } from "@cloudflare/polystella-core";
import { assertSingleGlossarySource, loadGlossaries } from "@cloudflare/polystella-cli/glossary";
import type { CatalogGlossaryConfig } from "@cloudflare/polystella-cli/config";

interface LoadGlossaryDefaultsBase {
  locales: ReadonlyArray<string>;
  signal?: AbortSignal | undefined;
}

export type LoadGlossaryDefaultsOptions =
  | (LoadGlossaryDefaultsBase & Extract<CatalogGlossaryConfig, { file: string }> & { projectRoot: URL })
  | (LoadGlossaryDefaultsBase & Exclude<CatalogGlossaryConfig, { file: string }> & { projectRoot?: URL | undefined });

/** Load structured per-locale YAML defaults while Astro evaluates its config. */
export async function loadGlossaryDefaults(options: LoadGlossaryDefaultsOptions): Promise<Record<string, Glossary>> {
  assertSingleGlossarySource(options);
  const glossaries =
    options.file !== undefined
      ? await loadGlossaries({
          config: { locales: options.locales, glossary: { file: options.file } },
          projectRoot: options.projectRoot,
          signal: options.signal,
        })
      : await loadGlossaries({
          config: { locales: options.locales, glossary: nonFileSource(options) },
          signal: options.signal,
        });
  return Object.fromEntries(glossaries);
}

function nonFileSource(options: Exclude<LoadGlossaryDefaultsOptions, { file: string }>): Exclude<CatalogGlossaryConfig, { file: string }> {
  if (options.inline !== undefined) return { inline: options.inline };
  if (options.http !== undefined) return { http: options.http };
  return { r2: options.r2 };
}
