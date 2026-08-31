/** Categorized prose instruction applied throughout a translation. */
export interface StyleRule {
  category: string;
  instruction: string;
  example?: string;
}

/** Locale-specific terminology and style constraints supplied to the model. */
export interface Glossary {
  version: string;
  doNotTranslate: string[];
  preferredTranslations: Record<string, string>;
  styleRules: StyleRule[];
  notes: string;
}

export const EMPTY_GLOSSARY: Glossary = {
  version: "",
  doNotTranslate: [],
  preferredTranslations: {},
  styleRules: [],
  notes: "",
};
