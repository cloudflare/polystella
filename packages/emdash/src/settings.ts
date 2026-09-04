import { EMPTY_GLOSSARY, type Glossary } from "@cloudflare/polystella-core";

export const DEPLOYMENT_DEFAULT_MODEL = "__polystella_deployment_default__";

export type GlossaryMode = "default" | "append" | "replace";

export function modelSettingKey(locale: string): string {
  return `model:${locale}`;
}

export function glossaryModeSettingKey(locale: string): string {
  return `glossaryMode:${locale}`;
}

export function glossarySettingKey(locale: string): string {
  return `glossary:${locale}`;
}

export function runtimeOverrideSettingKey(locale: string): string {
  return `runtimeOverride:${locale}`;
}

export function resolveGlossary(defaultGlossary: Glossary | undefined, mode: GlossaryMode, adminText: string): Glossary {
  if (mode === "replace") return { ...EMPTY_GLOSSARY, notes: adminText };
  const glossary = defaultGlossary ?? EMPTY_GLOSSARY;
  if (mode === "default" || adminText.length === 0) return glossary;
  return { ...glossary, notes: [glossary.notes, adminText].filter((value) => value.length > 0).join("\n") };
}

export function isGlossaryMode(value: unknown): value is GlossaryMode {
  return value === "default" || value === "append" || value === "replace";
}
