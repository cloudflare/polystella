import { describe, expect, it } from "vitest";

import { publicTranslationFailure } from "../src/server/routes/failures.js";

describe("publicTranslationFailure", () => {
  it("explains Workers AI timeouts and hides other provider errors", () => {
    const timeout = Object.assign(new Error("3046: Request timeout"), { name: "AiError" });
    expect(publicTranslationFailure(timeout)).toBe(
      "The translation model timed out (Workers AI error 3046). Try again, or translate fewer fields at once or pick a faster model.",
    );
    expect(publicTranslationFailure(Object.assign(new Error("5007: private detail"), { name: "AiError" }))).toBe(
      "PolyStella translation failed",
    );
  });
});
