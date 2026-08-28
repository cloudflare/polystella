import { jsonAdapter } from "@cloudflare/polystella-adapters";
import { buildPrompt, EMPTY_GLOSSARY } from "@cloudflare/polystella-core";
import { createWorkersAIBindingTranslator } from "@cloudflare/polystella-providers";

export default {
  async fetch(): Promise<Response> {
    const prompt = buildPrompt({
      segments: [{ id: "title", text: "Hello" }],
      glossary: EMPTY_GLOSSARY,
      sourceLocale: "en-US",
      targetLocale: "pt-BR",
    });
    const source = '{"entry":{"title":"Hello"}}';
    const parsed = jsonAdapter.parse(source);
    const output = jsonAdapter.applyTranslations(parsed, source, new Map([["entry.title", "Ola"]]));
    const translator = createWorkersAIBindingTranslator({
      modelId: "@cf/test/model",
      maxTokens: 32,
      run: async () => "Ola",
    });

    return Response.json({
      prompt: prompt.userPrompt.includes("@@title@@"),
      title: (JSON.parse(output) as { entry: { title: string } }).entry.title,
      translation: await translator.translate("system", "user"),
    });
  },
};
