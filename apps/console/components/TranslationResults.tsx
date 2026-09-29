import { Button, Label } from '@cloudflare/kumo';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { TranslationAccordionItem } from './TranslationAccordionItem';

interface TranslationResultsProps {
  translations: Record<string, string>;
  expandedLocales: Set<string>;
  copiedLocale: string | null;
  onToggleExpand: (locale: string) => void;
  onCopy: (text: string, locale: string) => void;
  onDownload: (text: string, locale: string) => void;
  onDownloadAll: () => void;
}

export function TranslationResults({
  translations,
  expandedLocales,
  copiedLocale,
  onToggleExpand,
  onCopy,
  onDownload,
  onDownloadAll
}: TranslationResultsProps) {
  if (Object.keys(translations).length === 0) return null;

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800">
      <div className="px-6 pt-4 pb-2 flex items-center justify-between">
        <Label>Translations</Label>
        <Button variant="secondary" onClick={onDownloadAll}>
          <DownloadSimpleIcon size={16} />
          Download All
        </Button>
      </div>
      <div>
        {Object.entries(translations).map(([locale, translation]) => (
          <TranslationAccordionItem
            key={locale}
            locale={locale}
            translation={translation}
            isExpanded={expandedLocales.has(locale)}
            isCopied={copiedLocale === locale}
            onToggle={() => onToggleExpand(locale)}
            onCopy={() => onCopy(translation, locale)}
            onDownload={() => onDownload(translation, locale)}
          />
        ))}
      </div>
    </div>
  );
}
