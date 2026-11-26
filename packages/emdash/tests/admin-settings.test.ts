import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiFlagStatusView } from "../src/admin/panels/AiFlagStatus.js";
import { maxTokensError } from "../src/admin/utils.js";
import type { AiTranslationStatus } from "../src/contracts.js";

function renderFlag(status: AiTranslationStatus, error: string | null = null): string {
  return renderToStaticMarkup(
    createElement(AiFlagStatusView, {
      status,
      working: null,
      error,
      confirmation: null,
      fieldLabel: (slug: string) => slug.toUpperCase(),
      onReview: () => {},
      onRetry: () => {},
    }),
  ).replaceAll("&#x27;", "'");
}

const flagged: AiTranslationStatus = { aiTranslated: true, aiTranslatedAt: null, model: "@cf/meta/llama", editedFields: [] };

describe("AiFlagStatusView", () => {
  it("offers Keep and Remove when edits couldn't be checked", () => {
    const html = renderFlag({ ...flagged, editedFields: null });
    expect(html).toContain("Couldn't check for edits");
    expect(html).toContain("Keep AI flag");
    expect(html).toContain("Remove AI flag");
    expect(html).not.toContain(">AI-translated<");
  });

  it("lists edited fields and hides Keep when nothing changed", () => {
    expect(renderFlag({ ...flagged, editedFields: ["title"] })).toContain("Changed: TITLE.");
    const calm = renderFlag(flagged);
    expect(calm).toContain("AI-translated");
    expect(calm).not.toContain("Keep AI flag");
    expect(calm).toContain("llama");
  });

  it("keeps the badge and actions next to an error with Retry", () => {
    const html = renderFlag(flagged, "Network down");
    expect(html).toContain("Remove AI flag");
    expect(html).toContain("Network down");
    expect(html).toContain("Retry");
  });
});

describe("AiFlagStatusView visibility", () => {
  it("renders nothing visible without a flag, and still shows errors and confirmations", () => {
    const hidden = renderFlag({ ...flagged, aiTranslated: false });
    expect(hidden).toContain("display:none");
    expect(hidden).not.toContain("Remove AI flag");
    expect(renderFlag({ ...flagged, aiTranslated: false }, "Boom")).not.toContain("display:none");
  });
});

describe("maxTokensError", () => {
  it("accepts empty and in-range whole numbers only", () => {
    expect([null, 256, 131_072].map(maxTokensError)).toEqual([undefined, undefined, undefined]);
    for (const value of [255, 131_073, 0, -256, 1000.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(maxTokensError(value)).toMatch(/whole number/);
  });
});
