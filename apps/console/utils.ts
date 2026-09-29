export function normalizeTranslation(translation: unknown): string {
  if (typeof translation === 'string') {
    try {
      const json: unknown = JSON.parse(translation);
      if (typeof json === 'object' && json !== null) {
        const parsed = json as Record<string, unknown>;
        if (typeof parsed.translation === 'string') return parsed.translation;
        if (typeof parsed.translated === 'string') return parsed.translated;
      }
      return JSON.stringify(json, null, 2) ?? '';
    } catch {
      return translation;
    }
  }
  return JSON.stringify(translation, null, 2) ?? '';
}

export function downloadFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
