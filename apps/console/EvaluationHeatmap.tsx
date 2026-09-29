import { useState, useMemo } from 'react';
import { Text, Label } from '@cloudflare/kumo';
import { ChartBarIcon, CaretDownIcon } from '@phosphor-icons/react';
import evaluationData from './evaluation-results.json';
import tokenUsageData from './token-usage.json';

// =============================================================================
// Types
// =============================================================================

interface SystemData {
  totalKeys: number;
  averageScore: number;
  lowQualityCount: number;
  lowQuality: LowQualityItem[];
  results: ResultItem[];
}

interface LowQualityItem {
  key: string;
  source: string;
  reference: string;
  hypothesis: string;
  score: number;
}

interface ResultItem {
  key: string;
  source: string;
  reference: string;
  hypothesis: string;
  score: number;
}

interface LocaleData {
  totalKeys: number;
  systems: Record<string, SystemData>;
  ranking: { system: string; score: number }[];
  pairwise: {
    system1: string;
    system2: string;
    winner: string;
    diff: number;
  }[];
}

interface EvaluationData {
  timestamp: string;
  sourceFile: string;
  mode: string;
  overallAverage: number;
  locales: Record<string, LocaleData>;
  rankings: { locale: string; score: number }[];
}

// =============================================================================
// Utilities
// =============================================================================

function getScoreColor(score: number): string {
  if (score >= 0.95) return 'bg-emerald-600';
  if (score >= 0.93) return 'bg-emerald-500';
  if (score >= 0.91) return 'bg-green-500';
  if (score >= 0.89) return 'bg-green-400';
  if (score >= 0.87) return 'bg-lime-400';
  if (score >= 0.85) return 'bg-lime-300';
  if (score >= 0.8) return 'bg-yellow-400';
  if (score >= 0.7) return 'bg-orange-400';
  return 'bg-red-500';
}

function getScoreTextColor(score: number): string {
  if (score >= 0.91) return 'text-white';
  return 'text-neutral-900';
}

// =============================================================================
// Components
// =============================================================================

interface HeatmapCellProps {
  score: number;
  isSelected: boolean;
  isWinner: boolean;
  onClick: () => void;
}

function HeatmapCell({
  score,
  isSelected,
  isWinner,
  onClick
}: HeatmapCellProps) {
  return (
    <button
      onClick={onClick}
      className={`
        w-full h-12 flex items-center justify-center rounded-md transition-all
        ${getScoreColor(score)} ${getScoreTextColor(score)}
                ${isSelected ? 'ring-2 ring-blue-600 ring-offset-2' : 'hover:ring-2 hover:ring-blue-400 hover:ring-offset-1'}
      `}
      title={`Score: ${score.toFixed(4)}${isWinner ? ' (Best)' : ''}`}
    >
      <span className="text-sm font-medium">
        {isWinner && '🏆 '}
        {score.toFixed(2)}
      </span>
    </button>
  );
}

interface DetailsPanel {
  locale: string;
  system: string;
  data: SystemData;
}

function DetailsPanel({ locale, system, data }: DetailsPanel) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="mt-6 p-4 rounded-lg bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Text variant="heading3">
            {locale} / {system}
          </Text>
          <Text variant="secondary" size="sm">
            Score: {data.averageScore.toFixed(4)} | Low Quality:{' '}
            {data.lowQualityCount}/{data.totalKeys} keys
          </Text>
        </div>
      </div>

      {data.lowQualityCount > 0 && (
        <div>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 mb-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <CaretDownIcon
              size={14}
              weight="bold"
              className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            />
            Low Quality Items ({data.lowQualityCount})
          </button>

          {isExpanded && (
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {data.lowQuality.map((item, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700"
                >
                  <div className="flex items-center justify-between mb-2">
                    <Text size="sm" bold>
                      {item.key}
                    </Text>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${getScoreColor(item.score)} ${getScoreTextColor(item.score)}`}
                    >
                      {item.score.toFixed(3)}
                    </span>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div>
                      <span className="text-neutral-500">Source: </span>
                      <span className="text-neutral-700 dark:text-neutral-300">
                        {item.source}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-500">Reference: </span>
                      <span className="text-neutral-700 dark:text-neutral-300">
                        {item.reference}
                      </span>
                    </div>
                    <div>
                      <span className="text-neutral-500">Hypothesis: </span>
                      <span className="text-neutral-700 dark:text-neutral-300">
                        {item.hypothesis}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data.lowQualityCount === 0 && (
        <Text variant="secondary" size="sm">
          ✓ All translations meet quality threshold (≥0.8)
        </Text>
      )}
    </div>
  );
}

// =============================================================================
// Token Usage
// =============================================================================

interface TokenUsageData {
  timestamp: string;
  sourceKeys: number;
  models: string[];
  locales: string[];
  usage: Record<string, Record<string, number>>;
}

function getModelAverage(
  usage: Record<string, Record<string, number>>,
  model: string
): number {
  const values = Object.values(usage[model] || {});
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function getModelMin(
  usage: Record<string, Record<string, number>>,
  model: string
): number {
  const values = Object.values(usage[model] || {});
  return Math.min(...values);
}

function getModelMax(
  usage: Record<string, Record<string, number>>,
  model: string
): number {
  const values = Object.values(usage[model] || {});
  return Math.max(...values);
}

function getTokenColor(tokens: number): string {
  if (tokens <= 2000)
    return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300';
  if (tokens <= 3500)
    return 'bg-lime-100 dark:bg-lime-900/30 text-lime-800 dark:text-lime-300';
  if (tokens <= 5000)
    return 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300';
  if (tokens <= 7000)
    return 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300';
  return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
}

function TokenUsageTable() {
  const tData = tokenUsageData as TokenUsageData;
  const { models, locales, usage } = tData;

  const sortedModels = [...models].sort(
    (a, b) => getModelAverage(usage, a) - getModelAverage(usage, b)
  );

  return (
    <div className="mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center gap-3 mb-4">
        <Text variant="heading3">Output Token Usage by Model</Text>
      </div>
      <div className="mb-4">
        <Text variant="secondary" size="sm">
          Tokens used per translation request ({tData.sourceKeys} source keys).
          Output tokens include both reasoning tokens (for thinking models) and
          the actual LLM response.
        </Text>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="p-2 text-left w-20">
                <Label>Model</Label>
              </th>
              {locales.map((locale) => (
                <th key={locale} className="p-2 text-center min-w-[70px]">
                  <Label>{locale.split('-')[0]}</Label>
                </th>
              ))}
              <th className="p-2 text-center min-w-[70px] border-l-2 border-neutral-300 dark:border-neutral-600">
                <Label>Avg</Label>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedModels.map((model) => {
              const avg = getModelAverage(usage, model);
              return (
                <tr key={model}>
                  <td className="p-2">
                    <Text size="sm" bold>
                      {model}
                    </Text>
                  </td>
                  {locales.map((locale) => {
                    const tokens = usage[model]?.[locale];
                    return (
                      <td key={locale} className="p-1">
                        <div
                          className={`w-full py-2 flex items-center justify-center rounded-md text-sm font-medium ${getTokenColor(tokens)}`}
                        >
                          {tokens ? tokens.toLocaleString() : '--'}
                        </div>
                      </td>
                    );
                  })}
                  <td className="p-1 border-l-2 border-neutral-300 dark:border-neutral-600">
                    <div
                      className={`w-full py-2 flex items-center justify-center rounded-md text-sm font-bold ${getTokenColor(avg)}`}
                    >
                      {avg.toLocaleString()}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-300" />
          <Text size="sm" variant="secondary">
            &le;2k
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-lime-100 dark:bg-lime-900/30 border border-lime-300" />
          <Text size="sm" variant="secondary">
            &le;3.5k
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300" />
          <Text size="sm" variant="secondary">
            &le;5k
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-orange-100 dark:bg-orange-900/30 border border-orange-300" />
          <Text size="sm" variant="secondary">
            &le;7k
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-red-100 dark:bg-red-900/30 border border-red-300" />
          <Text size="sm" variant="secondary">
            &gt;7k
          </Text>
        </div>
      </div>

      <div className="mt-6 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
        <div className="mb-2">
          <Text bold size="sm">
            Key Takeaways
          </Text>
        </div>
        <ul className="space-y-1">
          {sortedModels.map((model, i) => {
            const avg = getModelAverage(usage, model);
            const min = getModelMin(usage, model);
            const max = getModelMax(usage, model);
            return (
              <li key={model} className="flex items-start gap-2">
                <Text size="sm">
                  <span className="font-bold">{model}</span> — avg{' '}
                  {avg.toLocaleString()} tokens (range: {min.toLocaleString()}–
                  {max.toLocaleString()}){i === 0 && ' — most token-efficient'}
                  {i === sortedModels.length - 1 && ' — most token-heavy'}
                </Text>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-700">
        <Text variant="secondary" size="sm">
          Measured: {new Date(tData.timestamp).toLocaleString()}
        </Text>
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export default function EvaluationHeatmap() {
  const data = evaluationData as EvaluationData;
  const [selected, setSelected] = useState<{
    locale: string;
    system: string;
  } | null>(null);

  const { locales, systems, hasClaude } = useMemo(() => {
    const localeList = Object.keys(data.locales).sort();
    const systemSet = new Set<string>();

    for (const locale of localeList) {
      const localeData = data.locales[locale];
      if (localeData.systems) {
        Object.keys(localeData.systems).forEach((s) => systemSet.add(s));
      }
    }

    const allSystems = Array.from(systemSet).sort();
    const hasClaude = allSystems.includes('claude');
    const sortedSystems = hasClaude
      ? ['claude', ...allSystems.filter((s) => s !== 'claude')]
      : allSystems;

    return {
      locales: localeList,
      systems: sortedSystems,
      hasClaude
    };
  }, [data]);

  const getScore = (locale: string, system: string): number | null => {
    const localeData = data.locales[locale];
    if (!localeData?.systems?.[system]) return null;
    return localeData.systems[system].averageScore;
  };

  const selectedData = selected
    ? data.locales[selected.locale]?.systems?.[selected.system]
    : null;

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <ChartBarIcon
          size={24}
          weight="duotone"
          className="text-blue-600 dark:text-blue-400"
        />
        <div>
          <Text variant="heading3">Model Evaluation Heatmap</Text>
          <Text variant="secondary" size="sm">
            Comparing {systems.length} models across {locales.length} locales
          </Text>
        </div>
      </div>

      <div className="mb-4 italic">
        <Text variant="secondary" size="sm">
          💡 Click on any cell to see detailed results and low-quality
          translations
        </Text>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-red-500" />
          <Text size="sm" variant="secondary">
            &lt;0.7
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-orange-400" />
          <Text size="sm" variant="secondary">
            0.7
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-yellow-400" />
          <Text size="sm" variant="secondary">
            0.8
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-lime-300" />
          <Text size="sm" variant="secondary">
            0.85
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-lime-400" />
          <Text size="sm" variant="secondary">
            0.87
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-green-400" />
          <Text size="sm" variant="secondary">
            0.89
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-green-500" />
          <Text size="sm" variant="secondary">
            0.91
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-emerald-500" />
          <Text size="sm" variant="secondary">
            0.93
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-4 h-4 rounded bg-emerald-600" />
          <Text size="sm" variant="secondary">
            ≥0.95
          </Text>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="p-2 text-left w-24">
                <Label>Locale</Label>
              </th>
              {systems.map((system) => (
                <th
                  key={system}
                  className={`p-2 text-center min-w-[80px] ${
                    hasClaude && system === 'claude'
                      ? 'border-r-2 border-neutral-400 pr-4'
                      : hasClaude &&
                          systems[0] === 'claude' &&
                          systems[1] === system
                        ? 'pl-4'
                        : ''
                  }`}
                >
                  <Label>{system}</Label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {locales.map((locale) => (
              <tr key={locale}>
                <td className="p-2">
                  <Text size="sm" bold>
                    {locale}
                  </Text>
                </td>
                {systems.map((system) => {
                  const score = getScore(locale, system);
                  const isSelected =
                    selected?.locale === locale && selected?.system === system;
                  const ranking = data.locales[locale]?.ranking || [];
                  const winnerExcludingClaude = ranking.find(
                    (r) => r.system !== 'claude'
                  )?.system;
                  const isWinner = system === winnerExcludingClaude;

                  return (
                    <td
                      key={system}
                      className={`p-1 ${hasClaude && system === 'claude' ? 'border-r-2 border-neutral-400 pr-3' : hasClaude && systems[0] === 'claude' && systems[1] === system ? 'pl-3' : ''}`}
                    >
                      {score !== null ? (
                        <HeatmapCell
                          score={score}
                          isSelected={isSelected}
                          isWinner={isWinner}
                          onClick={() =>
                            setSelected(isSelected ? null : { locale, system })
                          }
                        />
                      ) : (
                        <div className="w-full h-12 flex items-center justify-center rounded-md bg-neutral-200 dark:bg-neutral-700 text-neutral-400">
                          --
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4">
        <Text variant="secondary" size="sm">
          Last updated: {new Date(data.timestamp).toLocaleString()} | Overall
          average: {data.overallAverage.toFixed(4)}
        </Text>
      </div>

      {selected && selectedData && (
        <DetailsPanel
          locale={selected.locale}
          system={selected.system}
          data={selectedData}
        />
      )}

      <TokenUsageTable />
    </div>
  );
}
