import { useState } from 'react';
import { Button, Text } from '@cloudflare/kumo';
import {
  CopyIcon,
  CheckIcon,
  DownloadSimpleIcon,
  CaretDownIcon,
  EnvelopeIcon
} from '@phosphor-icons/react';
import { LOCALES_MAP } from '../constants';
import { FeedbackDialog } from './FeedbackDialog';

interface TranslationAccordionItemProps {
  locale: string;
  translation: string;
  isExpanded: boolean;
  isCopied: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

export function TranslationAccordionItem({
  locale,
  translation,
  isExpanded,
  isCopied,
  onToggle,
  onCopy,
  onDownload
}: TranslationAccordionItemProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const localeInfo = LOCALES_MAP.get(locale);
  const displayName = localeInfo
    ? `${localeInfo.name} (${localeInfo.variant})`
    : locale;

  return (
    <div>
      <div
        onClick={onToggle}
        className="flex items-center justify-between px-6 py-2 bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 cursor-pointer transition-colors"
      >
        <div className="flex items-center gap-2 flex-1">
          <CaretDownIcon
            size={16}
            weight="bold"
            className={`text-neutral-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
          <Text bold>{displayName}</Text>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
          >
            {isCopied ? (
              <>
                <CheckIcon size={14} weight="bold" className="text-green-600" />
                Copied
              </>
            ) : (
              <>
                <CopyIcon size={14} />
                Copy
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            <DownloadSimpleIcon size={14} />
            Download
          </Button>
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setShowFeedback(true);
            }}
          >
            <EnvelopeIcon size={14} />
            Feedback
          </Button>
        </div>
      </div>
      {isExpanded && (
        <div className="mx-6 my-4 p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm leading-relaxed text-neutral-900 dark:text-neutral-100">
          {translation}
        </div>
      )}
      {showFeedback && (
        <FeedbackDialog
          locale={locale}
          translation={translation}
          onClose={() => setShowFeedback(false)}
        />
      )}
    </div>
  );
}
