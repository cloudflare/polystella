export interface TranslationCorrection {
  id: string;
  translation: string;
  problems: string[];
}

/** Prompt text that resends invalid answers with what was wrong, so the model can fix them. */
export function formatCorrections(corrections: readonly TranslationCorrection[]): string | undefined {
  if (corrections.length === 0) return undefined;
  const lines = ["CORRECTIONS (your previous answer for these segments was invalid; return a corrected translation for each):"];
  for (const { id, translation, problems } of corrections) {
    lines.push(`- Segment ${id}`, `  Previous answer: ${translation}`, `  Problem: ${problems.join("; ")}`);
  }
  return lines.join("\n");
}
