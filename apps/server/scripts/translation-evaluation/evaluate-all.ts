import { readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { TranslationEvaluator } from './evaluator';
import { CometScoringStrategy } from './scorers/comet-scorer';
import type { EvaluationSummary, ComparisonSummary } from './types';

interface MultiLocaleResults {
  timestamp: string;
  sourceFile: string;
  mode: 'single' | 'compare';
  overallAverage: number;
  locales: Record<string, EvaluationSummary | ComparisonSummary>;
  rankings: Array<{ locale: string; score: number }>;
}

async function discoverLocales(localesDir: string): Promise<string[]> {
  const entries = await readdir(localesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'en-US')
    .map((entry) => entry.name);
}

async function discoverHypothesisFiles(
  localeDir: string
): Promise<Record<string, string>> {
  const entries = await readdir(localeDir);
  const hypothesisFiles: Record<string, string> = {};

  for (const entry of entries) {
    if (
      entry.endsWith('.json') &&
      entry !== 'human_reference.json' &&
      entry !== 'source.json'
    ) {
      const systemName = entry
        .replace('.json', '')
        .replace(/-[a-z]{2}-[A-Z]{2}$/, '');
      hypothesisFiles[systemName] = join(localeDir, entry);
    }
  }

  return hypothesisFiles;
}

function printSingleSummaryTable(results: MultiLocaleResults): void {
  console.log('\n' + '='.repeat(80));
  console.log('                        MULTI-LOCALE EVALUATION SUMMARY');
  console.log('='.repeat(80));
  console.log();
  console.log(
    ' Locale    │ Avg Score │ Total Keys │ Low Quality (<0.8) │ Status'
  );
  console.log(
    '───────────┼───────────┼────────────┼────────────────────┼─────────'
  );

  for (const { locale, score } of results.rankings) {
    const summary = results.locales[locale] as EvaluationSummary;
    const status =
      score >= 0.8 ? '✓ Good' : score >= 0.7 ? '⚠ Review' : '✗ Poor';
    const localePadded = locale.padEnd(9);
    const scorePadded = score.toFixed(4).padStart(8);
    const keysPadded = String(summary.totalKeys).padStart(10);
    const lowQualityPadded = String(summary.lowQualityCount).padStart(18);

    console.log(
      ` ${localePadded} │ ${scorePadded}  │ ${keysPadded} │ ${lowQualityPadded}  │ ${status}`
    );
  }

  console.log(
    '───────────┴───────────┴────────────┴────────────────────┴─────────'
  );
  console.log();
  console.log(` Overall Average: ${results.overallAverage.toFixed(4)}`);
  console.log(
    ` Best Performing:  ${results.rankings[0].locale} (${results.rankings[0].score.toFixed(4)})`
  );

  const worst = results.rankings[results.rankings.length - 1];
  if (worst.score < 0.8) {
    console.log(
      ` Needs Review:     ${worst.locale} (${worst.score.toFixed(4)})`
    );
  }

  console.log();
  console.log('='.repeat(80));
}

function printComparisonSummaryTable(results: MultiLocaleResults): void {
  console.log('\n' + '='.repeat(90));
  console.log('                        MULTI-SYSTEM COMPARISON SUMMARY');
  console.log('='.repeat(90));

  for (const { locale } of results.rankings) {
    const summary = results.locales[locale] as ComparisonSummary;
    const winner = summary.ranking[0];
    console.log(`\n── ${locale} ${'─'.repeat(80)}`);
    console.log();
    console.log(' System Rankings:');
    console.log(' ┌────────────────┬───────────┬────────────────────┐');
    console.log(' │ System         │ Avg Score │ Low Quality (<0.8) │');
    console.log(' ├────────────────┼───────────┼────────────────────┤');

    for (const { system, score } of summary.ranking) {
      const sysData = summary.systems[system];
      const systemPadded = system.padEnd(14);
      const scorePadded = score.toFixed(4).padStart(9);
      const lowQualityPadded = String(sysData.lowQualityCount).padStart(18);
      console.log(
        ` │ ${systemPadded} │ ${scorePadded} │ ${lowQualityPadded} │`
      );
    }

    console.log(' └────────────────┴───────────┴────────────────────┘');
    console.log();
    console.log(` Winner: ${winner.system}`);
  }

  console.log();
  console.log('='.repeat(90));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(`
Usage: npm run evaluate:all -- <locales-dir> [options]

Arguments:
  locales-dir    Path to locales directory containing en-US and target locales

Options:
  --locales      Comma-separated list of locales to evaluate (default: all)
  --output       Output file path (default: evaluation-results-all.json)

Example:
  npm run evaluate:all -- api/scripts/translation-evaluation/locales
  npm run evaluate:all -- api/scripts/translation-evaluation/locales --locales zh-CN,de-DE

Expected directory structure:
  locales/
    en-US/
      source.json
    zh-CN/
      human_reference.json
      qwen-zh-CN.json         # Single system: uses single-mode evaluation
    de-DE/
      human_reference.json
      qwen-de-DE.json         # Multiple systems: auto-detects and uses
      deepl-de-DE.json        # comparison mode with rankings
      google-de-DE.json
    ...

Requirements:
  - Python 3.8+ with pip
  - Install dependencies: pip install -r api/scripts/translation-evaluation/scorers/requirements.txt

NB: Turn off WARP before running, the call to download the model from huggingface fails if WARP is on
    `);
    process.exit(1);
  }

  const localesDir = args[0];
  let outputPath = 'evaluation-results-all.json';
  let selectedLocales: string[] | null = null;

  // Parse optional arguments
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--locales' && args[i + 1]) {
      selectedLocales = args[i + 1].split(',').map((l) => l.trim());
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    }
  }

  // Discover or use specified locales
  let locales = selectedLocales || (await discoverLocales(localesDir));

  if (locales.length === 0) {
    console.error('No locales found to evaluate');
    process.exit(1);
  }

  console.log(
    `Found ${locales.length} locales to evaluate: ${locales.join(', ')}\n`
  );

  const sourcePath = join(localesDir, 'en-US', 'source.json');

  console.log('Using COMET scoring strategy (via Python)');
  console.log('Loading model once for all evaluations...\n');

  const scorer = new CometScoringStrategy();
  const evaluator = new TranslationEvaluator(scorer);

  const localeResults: Record<string, EvaluationSummary | ComparisonSummary> =
    {};
  let mode: 'single' | 'compare' = 'single';

  for (const locale of locales) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Evaluating: ${locale}`);
    console.log('─'.repeat(60));

    const localeDir = join(localesDir, locale);
    const referencePath = join(localeDir, 'human_reference.json');
    const hypothesisFiles = await discoverHypothesisFiles(localeDir);
    const systemNames = Object.keys(hypothesisFiles);

    if (systemNames.length === 0) {
      console.error(`✗ ${locale}: No hypothesis files found`);
      continue;
    }

    try {
      if (systemNames.length === 1) {
        const hypothesisPath = Object.values(hypothesisFiles)[0];
        console.log(`Single system detected: ${systemNames[0]}`);

        const summary = await evaluator.evaluateFiles(
          sourcePath,
          referencePath,
          hypothesisPath
        );
        localeResults[locale] = summary;
        console.log(
          `✓ ${locale}: Average score ${summary.averageScore.toFixed(4)}`
        );
      } else {
        mode = 'compare';
        console.log(`Multiple systems detected: ${systemNames.join(', ')}`);

        const summary = await evaluator.compareFiles(
          sourcePath,
          referencePath,
          hypothesisFiles
        );
        localeResults[locale] = summary;

        const bestSystem = summary.ranking[0];
        console.log(
          `✓ ${locale}: Best system: ${bestSystem.system} (${bestSystem.score.toFixed(4)})`
        );
      }
    } catch (error) {
      console.error(`✗ ${locale}: Failed - ${error}`);
    }
  }

  // Calculate overall metrics
  const completedLocales = Object.keys(localeResults);

  if (completedLocales.length === 0) {
    console.error('\nNo locales were successfully evaluated');
    process.exit(1);
  }

  const getAverageScore = (
    summary: EvaluationSummary | ComparisonSummary
  ): number => {
    if ('averageScore' in summary) {
      return summary.averageScore;
    }
    return summary.ranking[0]?.score ?? 0;
  };

  const overallAverage =
    completedLocales.reduce(
      (sum, loc) => sum + getAverageScore(localeResults[loc]),
      0
    ) / completedLocales.length;

  const rankings = completedLocales
    .map((locale) => ({
      locale,
      score: getAverageScore(localeResults[locale])
    }))
    .sort((a, b) => b.score - a.score);

  const results: MultiLocaleResults = {
    timestamp: new Date().toISOString(),
    sourceFile: sourcePath,
    mode,
    overallAverage,
    locales: localeResults,
    rankings
  };

  if (mode === 'single') {
    printSingleSummaryTable(results);
  } else {
    printComparisonSummaryTable(results);
  }

  await writeFile(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n✅ Detailed results saved to: ${outputPath}\n`);
}

main().catch((error) => {
  console.error('Error during evaluation:', error);
  process.exit(1);
});
