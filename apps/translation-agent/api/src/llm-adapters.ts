import {
  buildSystemContext,
  buildUserInput,
  generateJsonSchema,
  type PromptBuildMeta,
  type RetryContext
} from './prompt-utils';
import { isValidJSONString } from './validation-utils';

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

interface FormatInputResult {
  input: unknown;
  promptMeta: PromptBuildMeta;
}

interface LLMAdapter {
  modelId: keyof AiModels;
  supportsStreaming: boolean;
  /**
   * `sourceLocale` is required and feeds the "translating from X to Y"
   * wording in `buildSystemContext`/`buildUserInput`. The handler in
   * `api/src/index.ts` resolves an omitted request field to "en-US"
   * before this is called, so callers always have a value.
   */
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => FormatInputResult;
  formatStreamInput?: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => FormatInputResult;
  extractResponse: (response: unknown) => string | null;
  extractUsage: (response: unknown) => LLMUsage;
}

/** Safely access a property on an unknown value */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;

/**
 * Builds the system/user message pair and returns both the messages
 * and metadata about what prompt resources were loaded.
 */
const baseInput = (
  sourceLocale: string,
  locale: string,
  currentTextToTranslate: string,
  retryContext?: RetryContext
): { messages: LLMMessage[]; promptMeta: PromptBuildMeta } => {
  const { prompt: systemPrompt, meta: promptMeta } = buildSystemContext({
    sourceLocale,
    targetLocale: locale,
    sourceText: currentTextToTranslate,
    retryContext
  });
  return {
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildUserInput({
          text: currentTextToTranslate,
          sourceLocale,
          targetLocale: locale
        })
      }
    ],
    promptMeta
  };
};

const llamaAdapter: LLMAdapter = {
  modelId: '@cf/meta/llama-4-scout-17b-16e-instruct',
  supportsStreaming: false,
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    const llmRequestOptions: Record<string, unknown> = {
      messages,
      temperature: 0
    };

    if (isValidJSONString(currentTextToTranslate)) {
      llmRequestOptions.response_format = {
        type: 'json_object',
        json_schema: generateJsonSchema(currentTextToTranslate)
      };
    }
    return { input: llmRequestOptions, promptMeta };
  },
  extractResponse: (response: unknown) => {
    const r = asRecord(response);
    return typeof r?.response === 'string' ? r.response : null;
  },
  extractUsage: (response: unknown) => {
    const usage = asRecord(asRecord(response)?.usage);
    return {
      promptTokens: (usage?.prompt_tokens as number) ?? 0,
      completionTokens: (usage?.completion_tokens as number) ?? 0
    };
  }
};

const gptAdapter: LLMAdapter = {
  modelId: '@cf/openai/gpt-oss-120b',
  supportsStreaming: false,
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: {
        input: messages,
        temperature: 0,
        max_output_tokens: 10000
      } satisfies Base_Ai_Cf_Openai_Gpt_Oss_120B['inputs'],
      promptMeta
    };
  },
  extractResponse: (response: unknown) => {
    const r = asRecord(response);
    const output = Array.isArray(r?.output) ? r.output : [];
    const outputEntry = asRecord(output[1]);
    const content = Array.isArray(outputEntry?.content)
      ? outputEntry.content
      : [];
    const text = asRecord(content[0])?.text;
    return typeof text === 'string' ? text : null;
  },
  extractUsage: (response: unknown) => {
    const usage = asRecord(asRecord(response)?.usage);
    return {
      promptTokens: (usage?.input_tokens as number) ?? 0,
      completionTokens: (usage?.output_tokens as number) ?? 0
    };
  }
};

/** Shared extractor for chat-completion-style responses (qwen, kimi, glm) */
const extractChatResponse = (response: unknown): string | null => {
  const r = asRecord(response);
  const choices = Array.isArray(r?.choices) ? r.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  return typeof message?.content === 'string' ? message.content : null;
};

const extractChatUsage = (response: unknown): LLMUsage => {
  const usage = asRecord(asRecord(response)?.usage);
  return {
    promptTokens: (usage?.prompt_tokens as number) ?? 0,
    completionTokens: (usage?.completion_tokens as number) ?? 0
  };
};

const qwenAdapter: LLMAdapter = {
  modelId: '@cf/qwen/qwen3-30b-a3b-fp8',
  supportsStreaming: true,
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: {
        messages,
        temperature: 0,
        top_p: 0.001,
        top_k: 10,
        max_tokens: 10000
      } satisfies Base_Ai_Cf_Qwen_Qwen3_30B_A3B_Fp8['inputs'],
      promptMeta
    };
  },
  formatStreamInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: {
        messages,
        temperature: 0,
        top_p: 0.001,
        top_k: 10,
        max_tokens: 10000,
        stream: true
      },
      promptMeta
    };
  },
  extractResponse: extractChatResponse,
  extractUsage: extractChatUsage
};

const kimi2_5Adapter: LLMAdapter = {
  modelId: '@cf/moonshotai/kimi-k2.5' as keyof AiModels,
  supportsStreaming: true,
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: { messages, max_tokens: 20000 },
      promptMeta
    };
  },
  formatStreamInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: { messages, max_tokens: 20000, stream: true },
      promptMeta
    };
  },
  extractResponse: extractChatResponse,
  extractUsage: extractChatUsage
};

// GLM has just been added so testing it
const glmAdapter: LLMAdapter = {
  modelId: '@cf/zai-org/glm-4.7-flash' as keyof AiModels,
  supportsStreaming: true,
  formatInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: { messages, max_tokens: 10000 },
      promptMeta
    };
  },
  formatStreamInput: (
    sourceLocale: string,
    locale: string,
    currentTextToTranslate: string,
    retryContext?: RetryContext
  ) => {
    const { messages, promptMeta } = baseInput(
      sourceLocale,
      locale,
      currentTextToTranslate,
      retryContext
    );
    return {
      input: { messages, max_tokens: 10000, stream: true },
      promptMeta
    };
  },
  extractResponse: extractChatResponse,
  extractUsage: extractChatUsage
};

export async function callClaudeAPI(
  apiKey: string,
  sourceLocale: string,
  locale: string,
  textToTranslate: string
): Promise<string | null> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      system: buildSystemContext({
        sourceLocale,
        targetLocale: locale,
        sourceText: textToTranslate
      }).prompt,
      messages: [
        {
          role: 'user',
          content: buildUserInput({
            text: textToTranslate,
            sourceLocale,
            targetLocale: locale
          })
        }
      ],
      max_tokens: 10000,
      temperature: 0,
      top_k: 10
    })
  });

  const msg = (await response.json()) as Record<string, unknown>;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const text = asRecord(content[0])?.text;
  return typeof text === 'string' ? text : null;
}

const adapters = {
  llama: llamaAdapter,
  gpt: gptAdapter,
  kimi2_5: kimi2_5Adapter,
  qwen: qwenAdapter,
  glm: glmAdapter
};

export enum ValidModel {
  llama = 'llama',
  gpt = 'gpt',
  kimi2_5 = 'kimi2_5',
  qwen = 'qwen',
  glm = 'glm'
}

export type ModelType = keyof typeof adapters;

export const getAdapter = (model: ModelType) => {
  return adapters[model];
};

export type { LLMMessage, LLMAdapter };
