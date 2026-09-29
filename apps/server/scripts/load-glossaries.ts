import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import type { Glossary } from '@cloudflare/polystella-core';

import { DEFAULT_GLOSSARY_KEY, VALID_LOCALES } from '../src/locales';

const APP_ROOT = new URL('../', import.meta.url);
const OUTPUT = new URL('../src/generated/glossaries.json', import.meta.url);

async function main(): Promise<void> {
  if (process.argv.includes('--if-missing') && existsSync(OUTPUT)) return;

  const source = process.env.GLOSSARY_SOURCE?.trim();
  const glossaries = source ? await loadFromSource(source) : {};
  await mkdir(new URL('.', OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(glossaries)}\n`);
  const count = Object.keys(glossaries).length;
  console.log(
    `[glossaries] wrote ${count} glossaries${source ? '' : ' (GLOSSARY_SOURCE is not set)'}`
  );
}

async function loadFromSource(
  source: string
): Promise<Record<string, Glossary>> {
  // Lazy so builds without a source never touch Core's dist or Node-only loaders.
  const { resolveCatalogConfig } =
    await import('@cloudflare/polystella-core/cli/config');
  const { loadGlossaries } =
    await import('@cloudflare/polystella-core/cli/glossary');

  const { glossary } = resolveCatalogConfig(
    { glossary: JSON.parse(source) },
    { defaultLocale: '', locales: [] }
  );
  const locales = parseLocaleList(process.env.GLOSSARY_LOCALES);
  // HTTP and R2 sources fail on a missing locale; file sources skip it.
  if (locales === undefined && (glossary?.http ?? glossary?.r2)) {
    throw new Error(
      '[glossaries] GLOSSARY_LOCALES is required for http and r2 sources'
    );
  }

  const loaded = await loadGlossaries({
    config: {
      locales: locales ?? [...VALID_LOCALES, DEFAULT_GLOSSARY_KEY],
      glossary
    },
    projectRoot: APP_ROOT
  });
  return Object.fromEntries(loaded);
}

function parseLocaleList(value: string | undefined): string[] | undefined {
  const locales = value
    ?.split(',')
    .map((locale) => locale.trim())
    .filter((locale) => locale.length > 0);
  return locales?.length ? locales : undefined;
}

await main();
