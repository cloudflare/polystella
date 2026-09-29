import { Label } from '@cloudflare/kumo';
import { LOCALES, ADDITIONAL_LOCALES } from '../constants';

interface SourceLocaleSelectorProps {
  /**
   * Currently selected source locale BCP-47 code (e.g. "en-US").
   * Defaults to "en-US" via the parent's state initializer.
   */
  selectedSourceLocale: string;
  onChange: (sourceLocale: string) => void;
  disabled: boolean;
}

/**
 * Single-select dropdown for the source language. Mirrors the styling
 * of `ModelSelector` (raw `<select>` + Tailwind) for visual consistency
 * with the existing model picker. Switching to a Kumo primitive in a
 * follow-up should update both selectors together.
 *
 * The list shows the same locales available as targets, with the
 * primary 9 (which include English) shown first via `LOCALES`.
 */
export function SourceLocaleSelector({
  selectedSourceLocale,
  onChange,
  disabled
}: SourceLocaleSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Source Language</Label>
      <select
        value={selectedSourceLocale}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {LOCALES.map((locale) => (
          <option key={locale.code} value={locale.code}>
            {locale.name} ({locale.variant})
          </option>
        ))}
        {ADDITIONAL_LOCALES.map((locale) => (
          <option key={locale.code} value={locale.code}>
            {locale.name} ({locale.variant})
          </option>
        ))}
      </select>
    </div>
  );
}
