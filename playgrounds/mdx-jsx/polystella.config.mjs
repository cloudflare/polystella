// @ts-check

const localTranslate = process.env.POLYSTELLA_MDX_JSX_LOCAL_TRANSLATE === "1";
const workersAiTranslate = process.env.POLYSTELLA_MDX_JSX_WORKERS_AI_TRANSLATE === "1";
const fakeWorkersAiEndpoint = process.env.POLYSTELLA_MDX_JSX_FAKE_WORKERS_AI_ENDPOINT;

if (localTranslate && workersAiTranslate) {
  throw new Error("Only one MDX JSX playground translation mode can be enabled at a time.");
}

const translateMode = localTranslate ? "local" : workersAiTranslate ? "workers-ai" : "dry-run";

export default {
  sourceDir: "./src/content",
  include: ["**/*.{md,mdx}"],
  markdown: {
    keys: {
      "docs/**": ["title", "description"],
    },
    urls: {
      "docs/**": ["canonicalUrl"],
    },
    contextKeys: {
      "docs/**": ["title", "description"],
    },
    mdx: {
      recipes: [
        {
          components: {
            Badge: { children: true },
            Callout: { children: true, props: ["title"] },
            FeatureCard: { props: ["title", "description"] },
            FeatureGrid: { props: [] },
            Icon: { props: ["label"] },
          },
          data: {
            "docs/**": {
              blockFeatures: ["[].title", "[].description"],
              features: ["[].title", "[].description"],
            },
          },
        },
      ],
    },
  },
  ...translationModeConfig(translateMode),
  verbose: true,
};

/** @param {"dry-run" | "local" | "workers-ai"} mode */
function translationModeConfig(mode) {
  if (mode === "local") {
    return {
      provider: {
        kind: "workers-ai",
        accountId: "fake-account",
        apiToken: "fake-token",
        endpoint: fakeWorkersAiEndpoint ?? "http://127.0.0.1:8787/workers-ai",
        model: {
          default: "playground/fake-workers-ai",
          "pt-BR": "playground/fake-workers-ai/pt-BR",
          "fr-FR": "playground/fake-workers-ai/fr-FR",
        },
        maxTokens: 8192,
        batchInputTokenBudget: 4000,
      },
      debug: {
        previewDir: "./i18n-preview",
      },
      dryRun: false,
    };
  }

  if (mode === "workers-ai") {
    const accountId = requiredEnv("POLYSTELLA_WORKERS_AI_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID");
    const apiToken = requiredEnv("POLYSTELLA_WORKERS_AI_API_TOKEN", "CLOUDFLARE_WORKERS_AI_TOKEN", "CLOUDFLARE_API_TOKEN");
    const endpoint = process.env.POLYSTELLA_WORKERS_AI_ENDPOINT;
    return {
      provider: {
        kind: "workers-ai",
        accountId,
        apiToken,
        ...(endpoint ? { endpoint } : {}),
        model: process.env.POLYSTELLA_WORKERS_AI_MODEL ?? "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
        maxTokens: readPositiveIntegerEnv("POLYSTELLA_WORKERS_AI_MAX_TOKENS", 8192),
        batchInputTokenBudget: readPositiveIntegerEnv("POLYSTELLA_WORKERS_AI_BATCH_INPUT_TOKEN_BUDGET", 4000),
      },
      debug: {
        previewDir: "./i18n-preview",
      },
      dryRun: false,
    };
  }

  return { dryRun: true };
}

/** @param {string[]} names First set wins. */
function requiredEnv(...names) {
  const value = names.map((name) => process.env[name]).find(Boolean);
  if (!value) {
    throw new Error(`Missing required env var: one of ${names.join(", ")}.`);
  }
  return value;
}

/** @param {string} name @param {number} defaultValue */
function readPositiveIntegerEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
