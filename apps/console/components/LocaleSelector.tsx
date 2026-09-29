import { useState } from 'react';
import { Checkbox, Label, Text } from '@cloudflare/kumo';
import { CaretDownIcon } from '@phosphor-icons/react';
import { LOCALES, ADDITIONAL_LOCALES } from '../constants';

interface LocaleSelectorProps {
  selectedLocales: string[];
  onToggle: (code: string) => void;
  disabled: boolean;
  /**
   * BCP-47 code that should be disabled (cannot be selected as a target).
   * The API rejects requests where sourceLocale matches a targetLocale,
   * so we disable that chip here as a UX courtesy. Pass `undefined` to
   * leave all chips enabled.
   */
  disabledLocale?: string;
}

interface LocaleChipProps {
  locale: { code: string; name: string; variant: string };
  selectedLocales: string[];
  onToggle: (code: string) => void;
  disabled: boolean;
  /** Per-row disable, for the source-locale UX guard. */
  isLockedAsSource: boolean;
}

function LocaleChip({
  locale,
  selectedLocales,
  onToggle,
  disabled,
  isLockedAsSource
}: LocaleChipProps) {
  const isDisabled = disabled || isLockedAsSource;
  return (
    <div
      onClick={() => !isDisabled && onToggle(locale.code)}
      className={`flex items-center gap-2 p-2 rounded-md transition-colors ${
        isDisabled
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-700/50'
      }`}
      title={
        isLockedAsSource
          ? 'This language is selected as the source. Pick a different source language to enable it as a target.'
          : undefined
      }
    >
      <span onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selectedLocales.includes(locale.code)}
          onCheckedChange={() => onToggle(locale.code)}
          disabled={isDisabled}
          aria-label={`Select ${locale.name} (${locale.variant})`}
        />
      </span>
      <Text size="sm">
        {locale.name} ({locale.variant})
      </Text>
    </div>
  );
}

export function LocaleSelector({
  selectedLocales,
  onToggle,
  disabled,
  disabledLocale
}: LocaleSelectorProps) {
  const [showMore, setShowMore] = useState(false);
  const additionalSelectedCount = ADDITIONAL_LOCALES.filter((l) =>
    selectedLocales.includes(l.code)
  ).length;

  return (
    <div className="flex flex-col gap-2">
      <Label>Target Languages (select one or more)</Label>
      <div className="rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 p-4">
          {LOCALES.map((locale) => (
            <LocaleChip
              key={locale.code}
              locale={locale}
              selectedLocales={selectedLocales}
              onToggle={onToggle}
              disabled={disabled}
              isLockedAsSource={locale.code === disabledLocale}
            />
          ))}
        </div>

        <div className="border-t border-neutral-200 dark:border-neutral-700">
          <button
            type="button"
            onClick={() => setShowMore(!showMore)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700/50 transition-colors"
          >
            <span className="flex items-center gap-2">
              See more languages
              {additionalSelectedCount > 0 && (
                <span className="px-2 py-0.5 text-xs rounded-full bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
                  {additionalSelectedCount} selected
                </span>
              )}
            </span>
            <CaretDownIcon
              size={16}
              weight="bold"
              className={`transition-transform ${showMore ? 'rotate-180' : ''}`}
            />
          </button>

          {showMore && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 p-4 pt-0">
              {ADDITIONAL_LOCALES.map((locale) => (
                <LocaleChip
                  key={locale.code}
                  locale={locale}
                  selectedLocales={selectedLocales}
                  onToggle={onToggle}
                  disabled={disabled}
                  isLockedAsSource={locale.code === disabledLocale}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
