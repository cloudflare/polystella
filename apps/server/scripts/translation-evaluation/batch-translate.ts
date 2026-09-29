import { readFile, writeFile, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ValidModel } from '../../src/llm-adapters';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE_URL =
  process.env['API_URL'] || 'http://localhost:8787/api/translate';

type ModelType = ValidModel;

interface TranslationResponse {
  success: boolean;
  model: string;
  original: string;
  translations: Record<string, Record<string, string>>;
}

async function discoverLocales(localesDir: string): Promise<string[]> {
  const entries = await readdir(localesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'en-US')
    .map((entry) => entry.name);
}

async function translateForModel(
  sourceJson: string,
  model: ModelType,
  locales: string[]
): Promise<TranslationResponse> {
  console.log(`\n📤 Calling API for model: ${model}`);
  console.log(`   Locales: ${locales.join(', ')}`);

  const response = await fetch(API_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: sourceJson,
      targetLocale: locales.join(','),
      model
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<TranslationResponse>;
}

async function saveTranslations(
  localesDir: string,
  model: ModelType,
  translations: Record<string, Record<string, string>>
): Promise<void> {
  for (const [locale, content] of Object.entries(translations)) {
    const outputPath = join(localesDir, locale, `${model}-${locale}.json`);
    await writeFile(outputPath, JSON.stringify(content, null, 2) + '\n');
    console.log(`   ✓ Saved: ${outputPath}`);
  }
}

function parseArgs(): { models: ModelType[] } {
  const args = process.argv.slice(2);
  let models: ModelType[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--models' && args[i + 1]) {
      models = args[i + 1].split(',').map((m) => m.trim()) as ModelType[];
      i++;
    }
  }

  // Validate models
  for (const model of models) {
    if (!Object.values(ValidModel).includes(model)) {
      console.error(`Invalid model: ${model}`);
      console.error(`Valid models: ${Object.values(ValidModel).join(', ')}`);
      process.exit(1);
    }
  }

  if (models.length === 0) {
    console.error(`
Usage: npm run translate:batch -- --models <model1,model2>

Arguments:
  --models    Comma-separated list of models (required)
              Valid models: ${Object.values(ValidModel).join(', ')}

Example:
  npm run translate:batch -- --models gpt,kimi
`);
    process.exit(1);
  }

  return { models };
}

async function main() {
  const { models } = parseArgs();

  const localesDir = join(__dirname, 'locales');
  const sourcePath = join(localesDir, 'en-US', 'source.json');

  // Read source file
  console.log('📂 Reading source file...');
  const sourceJson = await readFile(sourcePath, 'utf-8');
  const sourceKeys = Object.keys(JSON.parse(sourceJson));
  console.log(`   Found ${sourceKeys.length} keys to translate`);

  // Discover target locales
  const locales = await discoverLocales(localesDir);
  console.log(`\n🌍 Target locales: ${locales.join(', ')}`);

  // Translate for each model
  console.log(`\n🤖 Models to run: ${models.join(', ')}`);

  const results = await Promise.all(
    models.map(async (model) => {
      try {
        const response = await translateForModel(sourceJson, model, locales);
        await saveTranslations(localesDir, model, response.translations);
        return { model, success: true };
      } catch (error) {
        console.error(`\n❌ Failed for model ${model}:`, error);
        return { model, success: false, error };
      }
    })
  );

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('SUMMARY');
  console.log('='.repeat(50));
  for (const result of results) {
    const status = result.success ? '✓' : '✗';
    console.log(`${status} ${result.model}`);
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    process.exit(1);
  }

  console.log('\n✅ All translations completed successfully!\n');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
