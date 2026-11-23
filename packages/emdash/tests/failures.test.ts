import { describe, expect, it } from "vitest";

import { ProviderTimeoutError } from "@cloudflare/polystella-core/providers/workers-ai";

import type { PolystellaEmdashOptions } from "../src/server/options.js";
import { publicTranslationFailure, translationFailureMessage } from "../src/server/routes/failures.js";
import { createTranslator } from "../src/server/routes/provider.js";

describe("publicTranslationFailure", () => {
  it("explains Workers AI timeouts and hides other provider errors", () => {
    const timeout = Object.assign(new Error("3046: Request timeout"), { name: "AiError" });
    expect(publicTranslationFailure(timeout)).toBe(
      "The translation model timed out (Workers AI error 3046). Try again, or translate fewer fields at once or pick a faster model.",
    );
    expect(publicTranslationFailure(new ProviderTimeoutError(200_000))).toBe(
      "The translation model timed out (no reply within 200 s). Try again, or translate fewer fields at once or pick a faster model.",
    );
    expect(publicTranslationFailure(Object.assign(new Error("5007: private detail"), { name: "AiError" }))).toBe(
      "PolyStella translation failed",
    );
  });

  it("logs the provider's reply info with the raw error", () => {
    const logged: unknown[] = [];
    const log = { error: (_message: string, data: unknown) => logged.push(data) } as unknown as Parameters<
      typeof translationFailureMessage
    >[1];
    const error = new Error("[polystella] no segment markers in the model response.");
    Object.defineProperty(error, "providerResponse", { value: { finishReason: "length", reasoningTokens: 8000 } });
    translationFailureMessage(error, log, "content", true, "id-1");
    expect(logged).toEqual([
      expect.objectContaining({ raw: [expect.objectContaining({ providerResponse: { finishReason: "length", reasoningTokens: 8000 } })] }),
    ]);
  });
});

describe("createTranslator", () => {
  it("sends the model's params, with the locale's enable_thinking", async () => {
    const inputs: unknown[] = [];
    const options = {
      provider: { kind: "workers-ai-binding", binding: "AI" },
      models: { allowed: ["glm"], defaults: "glm", params: { glm: { enable_thinking: { default: false, "ja-JP": true } } } },
    } as unknown as PolystellaEmdashOptions;
    const env = { AI: { run: async (_model: string, input: unknown) => (inputs.push(input), { response: "@@a@@\nHallo" }) } };
    const log = { error: () => undefined } as unknown as Parameters<typeof createTranslator>[4];
    for (const locale of ["de-DE", "ja-JP"]) {
      const translator = createTranslator(options, env, "glm", locale, log, { getEnv: async () => env, now: () => new Date() });
      await translator.translate("system", "user");
    }
    expect(inputs).toEqual([false, true].map((enable_thinking) => expect.objectContaining({ chat_template_kwargs: { enable_thinking } })));
  });
});
