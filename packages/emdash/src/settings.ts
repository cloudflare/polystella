import { EMPTY_GLOSSARY, type Glossary } from "@cloudflare/polystella-core";

import type { CustomizationMode } from "./contracts.js";

export function runtimeOverrideSettingKey(locale: string): string {
  return `runtimeOverride:${locale}`;
}

export function resolveGlossary(defaultGlossary: Glossary | undefined, mode: CustomizationMode, adminText: string): Glossary {
  if (mode === "replace") return { ...EMPTY_GLOSSARY, notes: adminText };
  const glossary = glossaryTerms(defaultGlossary ?? EMPTY_GLOSSARY);
  if (mode === "default" || adminText.length === 0) return glossary;
  return { ...glossary, notes: [glossary.notes, adminText].filter((value) => value.length > 0).join("\n") };
}

/** Only the fields translation uses, dropping extras such as a code glossary's `source` text. */
export function glossaryTerms({ version, doNotTranslate, preferredTranslations, styleRules, notes }: Glossary): Glossary {
  return { version, doNotTranslate, preferredTranslations, styleRules, notes };
}

export function resolveInstructions(defaultInstructions: readonly string[], mode: CustomizationMode, adminText: string): string {
  const defaultText = defaultInstructions.filter((value) => value.length > 0).join("\n");
  if (mode === "replace") return adminText;
  if (mode === "default" || adminText.length === 0) return defaultText;
  return [defaultText, adminText].filter((value) => value.length > 0).join("\n");
}

export function isCustomizationMode(value: unknown): value is CustomizationMode {
  return value === "default" || value === "append" || value === "replace";
}
