import { EMPTY_GLOSSARY, type Glossary } from "@cloudflare/polystella-core";

export type CustomizationMode = "default" | "append" | "replace";

export function runtimeOverrideSettingKey(locale: string): string {
  return `runtimeOverride:${locale}`;
}

export function resolveGlossary(defaultGlossary: Glossary | undefined, mode: CustomizationMode, adminText: string): Glossary {
  if (mode === "replace") return { ...EMPTY_GLOSSARY, notes: adminText };
  const glossary = defaultGlossary ?? EMPTY_GLOSSARY;
  if (mode === "default" || adminText.length === 0) return glossary;
  return { ...glossary, notes: [glossary.notes, adminText].filter((value) => value.length > 0).join("\n") };
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
