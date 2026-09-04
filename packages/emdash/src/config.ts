import type { Glossary } from "@cloudflare/polystella-core";
import { loadGlossaries } from "@cloudflare/polystella-cli/glossary";

export interface LoadGlossaryDefaultsOptions {
  file: string;
  locales: ReadonlyArray<string>;
  projectRoot: URL;
}

/** Load structured per-locale YAML defaults while Astro evaluates its config. */
export async function loadGlossaryDefaults(options: LoadGlossaryDefaultsOptions): Promise<Record<string, Glossary>> {
  const glossaries = await loadGlossaries({
    config: { locales: options.locales, glossary: { file: options.file } },
    projectRoot: options.projectRoot,
  });
  return Object.fromEntries(glossaries);
}
