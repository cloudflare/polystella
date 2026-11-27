import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { loadGlossaryDefaults } from "@cloudflare/polystella-emdash/config";

import arSA from "./src/i18n/ar-SA.json" with { type: "json" };
import enUS from "./src/i18n/en-US.json" with { type: "json" };
import jaJP from "./src/i18n/ja-JP.json" with { type: "json" };
import ptBR from "./src/i18n/pt-BR.json" with { type: "json" };
import { defaultLocale, locales } from "./locales.mjs";
import { allowedModels, fakeReasoningInput } from "./models.mjs";

/** @type {Record<string, string>} */
let envFile = {};
try {
  envFile = parseEnv(readFileSync(new URL("./.env", import.meta.url), "utf8"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
// Shell values win over .env here. The Worker only ever sees .env: wrangler does not pass shell variables on.
for (const [name, value] of Object.entries(envFile)) if (!(name in process.env)) process.env[name] = value;

export const fakeAiEndpoint = "http://127.0.0.1:8799/workers-ai";

const aiMode = process.env.POLYSTELLA_AI ?? "fake";
if (aiMode !== "fake" && aiMode !== "real") throw new Error(`POLYSTELLA_AI must be "fake" or "real", got "${aiMode}"`);
export const useFakeAi = aiMode === "fake";

// Fake mode uses its own variable names so a real token in .env is never sent to the local fake endpoint.
const fakeCredentials = { accountIdEnv: "POLYSTELLA_FAKE_ACCOUNT_ID", apiTokenEnv: "POLYSTELLA_FAKE_API_TOKEN" };
const realCredentials = { accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN" };
if (useFakeAi) {
  process.env[fakeCredentials.accountIdEnv] ??= "fake-account";
  process.env[fakeCredentials.apiTokenEnv] ??= "fake-token";
}
/** @param {Record<string, string | undefined>} source */
const hasCredentials = (source) => Boolean(source[realCredentials.accountIdEnv] && source[realCredentials.apiTokenEnv]);
const hasRealCredentials = hasCredentials(process.env);

/** On Cloudflare, real mode uses the AI binding (remote, needs `wrangler login`) unless .env holds credentials. */
export const useAiBinding = !useFakeAi && !hasRealCredentials;

// POLYSTELLA_AI_MODELS replaces the whole list in models.mjs; its first entry is the default. Blank means unset.
const modelOverride = (process.env.POLYSTELLA_AI_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const models = modelOverride.length > 0 ? modelOverride : allowedModels;

const glossaryDefaults = await loadGlossaryDefaults({
  locales: locales.filter((locale) => locale !== defaultLocale),
  file: "./src/i18n/glossary/{locale}.yaml",
  projectRoot: new URL(".", import.meta.url),
});

/**
 * @param {"node" | "cloudflare"} runtime
 * @returns {import("@cloudflare/polystella-emdash").PolystellaEmdashOptions}
 */
export function createPolystellaOptions(runtime) {
  if (runtime === "node" && !useFakeAi && !hasRealCredentials) {
    throw new Error(
      "POLYSTELLA_AI=real needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_WORKERS_AI_TOKEN. Copy .env.example to .env and fill them in.",
    );
  }
  if (runtime === "cloudflare" && !useFakeAi && hasRealCredentials && !hasCredentials(envFile)) {
    throw new Error("On Cloudflare the Worker reads credentials from .env only, not from shell variables. Put them in .env.");
  }
  const provider = useFakeAi
    ? { kind: /** @type {const} */ ("workers-ai-http"), ...fakeCredentials, endpoint: fakeAiEndpoint }
    : runtime === "cloudflare" && useAiBinding
      ? { kind: /** @type {const} */ ("workers-ai-binding"), binding: "AI" }
      : { kind: /** @type {const} */ ("workers-ai-http"), ...realCredentials };

  return {
    provider,
    ...(runtime === "cloudflare" ? { batchQueueBinding: "POLYSTELLA_BATCH" } : {}),
    catalogs: {
      defaultLocale,
      locales: {
        "en-US": { dictionary: enUS, filePath: "src/i18n/en-US.json" },
        "pt-BR": { dictionary: ptBR, filePath: "src/i18n/pt-BR.json" },
        "ja-JP": { dictionary: jaJP, filePath: "src/i18n/ja-JP.json" },
        "ar-SA": { dictionary: arSA, filePath: "src/i18n/ar-SA.json" },
      },
    },
    models: {
      allowed: models,
      // No `defaults`: the plugin falls back to the first allowed model until an administrator picks one.
      ...(useFakeAi
        ? {
            reasoningInput: Object.fromEntries(Object.entries(fakeReasoningInput).filter(([model]) => models.includes(model))),
            // Made-up prices, so the fake's usage tooltips show a cost estimate.
            prices: Object.fromEntries(models.map((model) => [model, { inputPerMillion: 0.3, outputPerMillion: 1.2 }])),
          }
        : {}),
    },
    glossaryDefaults,
    glossaryMatchInflections: true,
    // Text paths inside the `landing.layout` block types. link_url and icon are left out, so they are copied.
    blockFields: {
      hero: ["heading", "body", "link_label"],
      note: ["title", { path: "markdown", format: "markdown" }],
      cards: ["items[].title", "items[].description"],
    },
  };
}
