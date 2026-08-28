export interface StyleRule {
  category: string;
  instruction: string;
  example?: string;
}

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
