// Workers AI chat models the playground allows, default first. Each takes `messages` and `max_tokens`, as the plugin sends.
// Checked on 2026-11-26 against cloudflare-docs src/content/workers-ai-models; models with a planned_deprecation_date are left out.
export const allowedModels = [
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.3",
  // The catalogue says this model does not support max_tokens, so a run's token limit may not apply to it.
  "@cf/qwen/qwen3.8-27b",
  "@cf/thinkingmachines/inkling-2-small",
  "@cf/google/gemma-4-26b-a4b-it",
  // The catalogue does not document these two models' reply shape, but both parsed fine in a real run on 2026-11-26.
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
];

// The thinking choices these models offer in the live catalogue, mapped as the plugin maps them. The fake AI has no
// catalogue, so the options pass these in to make the thinking pickers work offline. Real mode reads the live one.
/** @param {...string} names */
const efforts = (...names) => Object.fromEntries(names.map((name) => [name, { reasoning_effort: name }]));
const onOff = { none: { enable_thinking: false }, on: { enable_thinking: true } };
export const fakeReasoningInput = {
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": efforts("max", "high", "low", "none"),
  "@cf/zai-org/glm-4.7-flash": onOff,
  "@cf/zai-org/glm-5.3": efforts("max", "high", "low"),
  "@cf/qwen/qwen3.8-27b": { ...efforts("low", "medium", "xhigh"), none: { enable_thinking: false } },
  "@cf/thinkingmachines/inkling-2-small": efforts("max", "high", "medium", "low", "minimal", "none"),
  "@cf/google/gemma-4-26b-a4b-it": onOff,
  "@cf/openai/gpt-oss-120b": efforts("low", "medium", "high"),
  "@cf/openai/gpt-oss-20b": efforts("low", "medium", "high"),
};
