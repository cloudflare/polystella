import { useState } from 'react';
import { EnvelopeIcon, XIcon } from '@phosphor-icons/react';
import { LOCALES_MAP } from '../constants';

interface FeedbackDialogProps {
  locale: string;
  translation: string;
  onClose: () => void;
}

export function FeedbackDialog({
  locale,
  translation,
  onClose
}: FeedbackDialogProps) {
  const [feedback, setFeedback] = useState('');
  const localeInfo = LOCALES_MAP.get(locale);
  const displayName = localeInfo
    ? `${localeInfo.name} (${localeInfo.variant})`
    : locale;
  const preview =
    translation.slice(0, 100) + (translation.length > 100 ? '...' : '');

  const handleSubmit = () => {
    const subject = encodeURIComponent(
      `Translation Feedback - ${displayName} (${locale})`
    );
    const body = encodeURIComponent(
      `Locale: ${displayName} (${locale})\n\nTranslation Preview:\n${preview}\n\nFeedback:\n${feedback}`
    );
    window.open(
      `mailto:translations@example.invalid?subject=${subject}&body=${body}`,
      '_blank'
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-700">
          <span className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Feedback - {displayName}
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <XIcon size={18} className="text-neutral-500" />
          </button>
        </div>
        <div className="px-6 py-4 flex flex-col gap-4">
          <div>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Translation Preview
            </span>
            <div className="mt-1 p-3 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-sm leading-relaxed text-neutral-900 dark:text-neutral-100">
              {preview}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Your Feedback
            </span>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Describe any issues or suggestions for this translation..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-neutral-200 dark:border-neutral-700">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!feedback.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <EnvelopeIcon size={14} />
            Send Feedback
          </button>
        </div>
      </div>
    </div>
  );
}
