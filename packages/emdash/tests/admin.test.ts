import { describe, expect, it } from "vitest";

import { contentEditorPanels, pages } from "../src/admin.js";

describe("EmDash admin entry", () => {
  it("exports the declared pages and editor panel", () => {
    expect(Object.keys(pages)).toEqual(["/catalog", "/settings"]);
    expect(contentEditorPanels).toHaveLength(1);
    expect(contentEditorPanels[0]).toMatchObject({ id: "polystella", title: "PolyStella", minRole: 40 });
  });
});
