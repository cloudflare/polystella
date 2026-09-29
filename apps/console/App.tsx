import { useState, useMemo } from 'react';
import EvaluationHeatmap from './EvaluationHeatmap';
import { Button, LayerCard, Text } from '@cloudflare/kumo';
import { TrashIcon, SpinnerGapIcon } from '@phosphor-icons/react';
import type { TranslationResponse } from './types';
import { TOKEN_LIMIT, encoder } from './constants';
import { normalizeTranslation, downloadFile } from './utils';
import { Header } from './components/Header';
import { TextInput } from './components/TextInput';
import { ModelSelector } from './components/ModelSelector';
import { LocaleSelector } from './components/LocaleSelector';
import { SourceLocaleSelector } from './components/SourceLocaleSelector';
import { ErrorAlert } from './components/ErrorAlert';
import { TranslationResults } from './components/TranslationResults';

/**
 * Default source locale matches the API's DEFAULT_SOURCE_LOCALE so the
 * UI's initial state is identical to what an API caller who omits
 * `sourceLocale` would get. Backward compatible with the old "translate
 * English to anything" UX. See UI-8255.
 */
const DEFAULT_SOURCE_LOCALE = 'en-US';

function App() {
  const [activeTab, setActiveTab] = useState<'translate' | 'evaluation'>(
    'translate'
  );
  const [inputText, setInputText] = useState('');
  const [sourceLocale, setSourceLocale] = useState<string>(
    DEFAULT_SOURCE_LOCALE
  );
  const [targetLocales, setTargetLocales] = useState<string[]>(['es-ES']);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [expandedLocales, setExpandedLocales] = useState<Set<string>>(
    new Set()
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedLocale, setCopiedLocale] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('qwen');

  const tokenCount = useMemo(() => {
    if (!inputText.trim()) return 0;
    try {
      return encoder.encode(inputText).length;
    } catch {
      return 0;
    }
  }, [inputText]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!inputText.trim()) {
      setError('Please enter some text to translate');
      return;
    }

    if (tokenCount > TOKEN_LIMIT) {
      setError(`Text exceeds the maximum limit of ${TOKEN_LIMIT} tokens`);
      return;
    }

    setIsLoading(true);
    setError('');
    setTranslations({});

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText,
          sourceLocale,
          targetLocale: targetLocales.join(','),
          model: selectedModel
        })
      });

      const data: TranslationResponse = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error || data.details || 'Translation failed');
      }

      const normalized: Record<string, string> = {};
      Object.entries(data.translations).forEach(([locale, translation]) => {
        normalized[locale] = normalizeTranslation(translation);
      });
      setTranslations(normalized);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'An unexpected error occurred'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setInputText('');
    setTranslations({});
    setExpandedLocales(new Set());
    setError('');
  };

  const handleLocaleToggle = (code: string) => {
    setTargetLocales((prev) => {
      if (prev.includes(code)) {
        return prev.length === 1 ? prev : prev.filter((c) => c !== code);
      }
      return [...prev, code];
    });
  };

  const handleToggleExpand = (locale: string) => {
    setExpandedLocales((prev) => {
      const next = new Set(prev);
      next.has(locale) ? next.delete(locale) : next.add(locale);
      return next;
    });
  };

  const handleCopy = async (text: string, locale: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLocale(locale);
      setTimeout(() => setCopiedLocale(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleDownload = (text: string, locale: string) => {
    downloadFile(text, `translation-${locale}.txt`);
  };

  const handleDownloadAll = () => {
    Object.entries(translations).forEach(([locale, translation]) => {
      downloadFile(translation, `translation-${locale}.txt`);
    });
  };

  // `hasValidTargets` blocks submission when every selected target equals
  // the source. The chip is already disabled visually via
  // LocaleSelector's `disabledLocale` prop, but selection state may still
  // hold the value (e.g. user changes source AFTER selecting a target).
  // Without this guard, a user with `targetLocales=['en-US']` who picks
  // English as source could still hit Translate and get a server-side
  // 400. Mirrors the same-as-target check in the API's superRefine.
  const hasValidTargets =
    targetLocales.length > 0 &&
    targetLocales.some((target) => target !== sourceLocale);
  const canSubmit =
    !isLoading &&
    inputText.trim() &&
    tokenCount <= TOKEN_LIMIT &&
    hasValidTargets;

  return (
    <div className="min-h-screen bg-neutral-200 dark:bg-neutral-950 py-32 px-4">
      <div className="mx-auto mt-8 max-w-5xl">
        <LayerCard>
          <Header activeTab={activeTab} onTabChange={setActiveTab} />

          <LayerCard.Primary>
            {activeTab === 'translate' ? (
              <>
                <form
                  onSubmit={handleSubmit}
                  className="p-6 flex flex-col gap-5"
                >
                  <SourceLocaleSelector
                    selectedSourceLocale={sourceLocale}
                    onChange={(code) => {
                      setSourceLocale(code);
                      // If the new source matches a currently-selected
                      // target, drop it. The API would reject the request
                      // anyway; this keeps the UI in a valid state.
                      // Defensive guard: never drop the last target chip
                      // (handleLocaleToggle keeps the list non-empty).
                      setTargetLocales((prev) =>
                        prev.length > 1 && prev.includes(code)
                          ? prev.filter((c) => c !== code)
                          : prev
                      );
                    }}
                    disabled={isLoading}
                  />

                  <TextInput
                    value={inputText}
                    onChange={setInputText}
                    tokenCount={tokenCount}
                    disabled={isLoading}
                    sourceLocale={sourceLocale}
                  />

                  <LocaleSelector
                    selectedLocales={targetLocales}
                    onToggle={handleLocaleToggle}
                    disabled={isLoading}
                    disabledLocale={sourceLocale}
                  />

                  <ModelSelector
                    selectedModel={selectedModel}
                    onChange={setSelectedModel}
                    disabled={isLoading}
                  />

                  <div className="flex gap-3">
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={!canSubmit}
                    >
                      {isLoading ? (
                        <>
                          <SpinnerGapIcon size={16} className="animate-spin" />
                          Translating...
                        </>
                      ) : (
                        'Translate'
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleClear}
                      disabled={isLoading}
                    >
                      <TrashIcon size={16} />
                      Clear
                    </Button>
                  </div>
                </form>

                {error && <ErrorAlert message={error} />}

                <TranslationResults
                  translations={translations}
                  expandedLocales={expandedLocales}
                  copiedLocale={copiedLocale}
                  onToggleExpand={handleToggleExpand}
                  onCopy={handleCopy}
                  onDownload={handleDownload}
                  onDownloadAll={handleDownloadAll}
                />
              </>
            ) : (
              <EvaluationHeatmap />
            )}
          </LayerCard.Primary>
        </LayerCard>

        <footer className="mt-6 text-center">
          <Text variant="secondary" size="sm">
            Powered by Cloudflare Workers AI
          </Text>
        </footer>
      </div>
    </div>
  );
}

export default App;
