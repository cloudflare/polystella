import { jsonAdapter } from "@cloudflare/polystella-adapters";
import { EMPTY_GLOSSARY, translateSegments, type Translator } from "@cloudflare/polystella-core";
import { createWorkersAIBindingTranslator, type WorkersAIInput } from "@cloudflare/polystella-providers/workers-ai";

interface WorkersAIBinding {
  run(modelId: string, input: WorkersAIInput): Promise<unknown>;
}

export async function translateRecord(ai: WorkersAIBinding): Promise<string> {
  const source = JSON.stringify({ title: "Hello" });
  const parsed = jsonAdapter.parse(source, "record.json");
  const segments = jsonAdapter.extractSegments(parsed, source, {
    sourcePath: "record.json",
    translatableKeys: { "record.json": ["title"] },
  });
  const translator: Translator = createWorkersAIBindingTranslator({
    modelId: "@cf/meta/llama-3.1-8b-instruct",
    maxTokens: 8192,
    run: (modelId, input) => ai.run(modelId, input),
  });
  const { translations } = await translateSegments({
    translator,
    segments,
    glossary: EMPTY_GLOSSARY,
    sourceLocale: "en-US",
    targetLocale: "pt-BR",
  });
  return jsonAdapter.applyTranslations(parsed, source, translations);
}
