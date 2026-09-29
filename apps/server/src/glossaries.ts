import type { Glossary } from '@cloudflare/polystella-core';

import generated from './generated/glossaries.json';

// Written by `scripts/load-glossaries.ts` before dev/build; `{}` when no source is configured.
export const GLOSSARIES: Partial<Record<string, Glossary>> = generated;
