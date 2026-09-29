import { writeFile } from 'fs/promises';
import { TranslationEvaluator } from './evaluator';
import { CometScoringStrategy } from './scorers/comet-scorer';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 3) {
    console.error(`
Usage: npm run evaluate -- <source> <reference> <hypothesis>

Arguments:
  source      Path to source English JSON file
  reference   Path to human-translated reference JSON file
  hypothesis  Path to LLM-generated translation JSON file

Example:
  npm run evaluate -- \\
    api/locales/translations/en-US/ai.json \\
    api/locales/translations/zh-CN/human_translated.json \\
    api/locales/translations/zh-CN/ai.json

Requirements:
  - Python 3.8+ with pip
  - Install dependencies: pip install -r api/scripts/translation-evaluation/scorers/requirements.txt

NB:  Turn off WARP before running the evaluation script, for some reason the call to download the model from huggingface fails if WARP is on
    `);
    process.exit(1);
  }

  const [sourcePath, referencePath, hypothesisPath] = args;

  console.log('Using COMET scoring strategy (via Python)\n');
  const scorer = new CometScoringStrategy();

  const evaluator = new TranslationEvaluator(scorer);

  console.log('Starting evaluation...');
  console.log(`Source: ${sourcePath}`);
  console.log(`Reference: ${referencePath}`);
  console.log(`Hypothesis: ${hypothesisPath}\n`);

  const summary = await evaluator.evaluateFiles(
    sourcePath,
    referencePath,
    hypothesisPath
  );

  console.log('='.repeat(60));
  console.log('EVALUATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Keys Evaluated: ${summary.totalKeys}`);
  console.log(`Average Score: ${summary.averageScore.toFixed(4)}`);
  console.log(`Low Quality Keys (<0.8): ${summary.lowQuality.length}`);
  console.log('='.repeat(60));

  if (summary.lowQuality.length > 0) {
    console.log('\n🔴 LOW QUALITY TRANSLATIONS:\n');
    summary.lowQuality.slice(0, 10).forEach((r) => {
      console.log(`  ${r.key}`);
      console.log(`    Score: ${r.score.toFixed(4)}`);
      console.log(`    Source: ${r.source.substring(0, 60)}...`);
      console.log(`    Hypothesis: ${r.hypothesis.substring(0, 60)}...`);
      console.log();
    });

    if (summary.lowQuality.length > 10) {
      console.log(`  ... and ${summary.lowQuality.length - 10} more\n`);
    }
  }

  const outputPath = 'evaluation-results.json';
  await writeFile(outputPath, JSON.stringify(summary, null, 2));
  console.log(`\n✅ Detailed results saved to: ${outputPath}\n`);
}

main().catch((error) => {
  console.error('Error during evaluation:', error);
  process.exit(1);
});
