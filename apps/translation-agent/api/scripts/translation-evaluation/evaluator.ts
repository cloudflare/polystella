import { readFile } from 'fs/promises';
import type {
  EvaluationResult,
  EvaluationSummary,
  ScoringStrategy,
  ComparisonSummary
} from './types';

export class TranslationEvaluator {
  constructor(private scorer: ScoringStrategy) {}

  async evaluateFiles(
    sourcePath: string,
    referencePath: string,
    hypothesisPath: string
  ): Promise<EvaluationSummary> {
    console.log('Loading translation files...');

    const [source, reference, hypothesis] = await Promise.all([
      this.loadJson(sourcePath),
      this.loadJson(referencePath),
      this.loadJson(hypothesisPath)
    ]);

    console.log(`Found ${Object.keys(source).length} keys to evaluate\n`);

    const segments: Array<{
      key: string;
      source: string;
      reference: string;
      hypothesis: string;
    }> = [];

    for (const key of Object.keys(source)) {
      if (!reference[key] || !hypothesis[key]) {
        console.warn(`⚠️  Missing translation for key: ${key}`);
        continue;
      }

      segments.push({
        key,
        source: source[key],
        reference: reference[key],
        hypothesis: hypothesis[key]
      });
    }

    console.log(`Evaluating ${segments.length} segments in batch...`);

    const spinner = this.startSpinner();
    const scores = await this.scorer.computeBatchScores(
      segments.map((seg) => ({
        source: seg.source,
        reference: seg.reference,
        hypothesis: seg.hypothesis
      }))
    );
    this.stopSpinner(spinner);

    const results: EvaluationResult[] = segments.map((seg, index) => ({
      key: seg.key,
      source: seg.source,
      reference: seg.reference,
      hypothesis: seg.hypothesis,
      score: scores[index]
    }));

    console.log(`\nCompleted: ${results.length} segments evaluated\n`);

    return this.generateSummary(results);
  }

  async compareFiles(
    sourcePath: string,
    referencePath: string,
    hypothesisPaths: Record<string, string>
  ): Promise<ComparisonSummary> {
    console.log('Loading translation files for comparison...');

    const [source, reference] = await Promise.all([
      this.loadJson(sourcePath),
      this.loadJson(referencePath)
    ]);

    const hypotheses: Record<string, Record<string, string>> = {};
    for (const [systemName, path] of Object.entries(hypothesisPaths)) {
      hypotheses[systemName] = await this.loadJson(path);
    }

    const systemNames = Object.keys(hypotheses);
    console.log(
      `Comparing ${systemNames.length} systems: ${systemNames.join(', ')}`
    );
    console.log(`Found ${Object.keys(source).length} keys to evaluate\n`);

    const segments: Array<{
      key: string;
      source: string;
      reference: string;
      hypotheses: Record<string, string>;
    }> = [];

    for (const key of Object.keys(source)) {
      if (!reference[key]) {
        console.warn(`⚠️  Missing reference for key: ${key}`);
        continue;
      }

      const keyHypotheses: Record<string, string> = {};
      let missingHypothesis = false;

      for (const systemName of systemNames) {
        if (!hypotheses[systemName][key]) {
          console.warn(`⚠️  Missing ${systemName} translation for key: ${key}`);
          missingHypothesis = true;
          break;
        }
        keyHypotheses[systemName] = hypotheses[systemName][key];
      }

      if (missingHypothesis) continue;

      segments.push({
        key,
        source: source[key],
        reference: reference[key],
        hypotheses: keyHypotheses
      });
    }

    console.log(
      `Comparing ${segments.length} segments across ${systemNames.length} systems...`
    );

    const spinner = this.startSpinner();
    const comparison = await this.scorer.compareSystems(
      segments.map((seg) => ({
        source: seg.source,
        reference: seg.reference,
        hypotheses: seg.hypotheses
      }))
    );
    this.stopSpinner(spinner);

    console.log(`\nCompleted: ${segments.length} segments compared\n`);

    const systemSummaries: Record<string, EvaluationSummary> = {};

    for (const systemName of systemNames) {
      const results: EvaluationResult[] = segments.map((seg, index) => ({
        key: seg.key,
        source: seg.source,
        reference: seg.reference,
        hypothesis: seg.hypotheses[systemName],
        score: comparison.systems[systemName].scores[index]
      }));

      systemSummaries[systemName] = this.generateSummary(results);
    }

    return {
      totalKeys: segments.length,
      systems: systemSummaries,
      ranking: comparison.ranking,
      pairwise: comparison.pairwise
    };
  }

  private async loadJson(path: string): Promise<Record<string, string>> {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  }

  private startSpinner(): NodeJS.Timeout {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;

    process.stdout.write(' ');
    const interval = setInterval(() => {
      process.stdout.write(`\r${frames[i]} Running COMET evaluation...`);
      i = (i + 1) % frames.length;
    }, 80);

    return interval;
  }

  private stopSpinner(interval: NodeJS.Timeout): void {
    clearInterval(interval);
    process.stdout.write('\r✓ COMET evaluation complete\n');
  }

  private generateSummary(results: EvaluationResult[]): EvaluationSummary {
    const averageScore =
      results.reduce((sum, r) => sum + r.score, 0) / results.length;
    const lowQuality = results.filter((r) => r.score < 0.8);

    return {
      totalKeys: results.length,
      averageScore,
      lowQualityCount: lowQuality.length,
      lowQuality,
      results: results.sort((a, b) => a.score - b.score)
    };
  }
}
