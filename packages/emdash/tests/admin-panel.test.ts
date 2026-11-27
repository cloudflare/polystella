import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_CONTENT_FIELDS } from "../src/contracts.js";
import { FieldChips, selectAllFields, type FieldOption } from "../src/admin/components/FieldChips/FieldChips.js";
import { PanelWarningBanner } from "../src/admin/panels/ContentEditorPanel.js";
import { SWITCH_ON_CLASS } from "../src/admin/styles.js";

const options: FieldOption[] = [
  { slug: "title", label: "Title", disabled: false },
  { slug: "seo_title", label: "SEO title", disabled: false },
  { slug: "seo_description", label: "Meta description", disabled: true },
];

describe("FieldChips", () => {
  it("shows fields as toggle chips labelled without slugs", () => {
    const html = renderToStaticMarkup(createElement(FieldChips, { options, selected: ["title"], disabled: false, onChange: () => {} }));
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Title</);
    expect(html).toContain(`class="${SWITCH_ON_CLASS}"`);
    expect(html.match(new RegExp(SWITCH_ON_CLASS, "g"))).toHaveLength(1);
    expect(html).not.toContain("(title)");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear all");
    expect(html).not.toContain("selected.");
  });

  it("selects every enabled field up to the field limit, keeping the current choice", () => {
    expect(selectAllFields(options)).toEqual(["title", "seo_title"]);
    expect(selectAllFields(options, ["seo_title"])).toEqual(["seo_title", "title"]);
    expect(selectAllFields(options, ["title"], 1)).toEqual(["title"]);
    const many = Array.from({ length: MAX_CONTENT_FIELDS + 3 }, (_, index) => ({ slug: `f${index}`, label: `F${index}`, disabled: false }));
    expect(selectAllFields(many)).toHaveLength(MAX_CONTENT_FIELDS);
  });

  it("disables Clear all when nothing is selected", () => {
    const html = renderToStaticMarkup(createElement(FieldChips, { options, selected: [], disabled: false, onChange: () => {} }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<[^>]+>)?Clear all</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(<[^>]+>)?Select all</);
  });

  it("disables Select all when every enabled field is selected or the limit is reached", () => {
    const render = (selected: string[], max?: number) =>
      renderToStaticMarkup(createElement(FieldChips, { options, selected, disabled: false, max, onChange: () => {} }));
    const selectAllDisabled = /<button[^>]*disabled=""[^>]*>(<[^>]+>)?Select all</;
    expect(render(["title", "seo_title"])).toMatch(selectAllDisabled);
    expect(render(["title"], 1)).toMatch(selectAllDisabled);
    expect(render(["title"])).not.toMatch(selectAllDisabled);
  });
});

describe("PanelWarningBanner", () => {
  const render = (blockTypes: string[], lines: string[] = []) =>
    renderToStaticMarkup(
      createElement(PanelWarningBanner, { warning: { blockTypes, lines, reload: false }, onDismiss: () => {} }),
    ).replaceAll("&#x27;", "'");

  it("names one untranslated block type with a short reason and an icon dismiss", () => {
    const html = render(["featured_logos"]);
    expect(html).toContain("1 block type copied untranslated");
    expect(html).toContain("<code>featured_logos</code> isn't in blockFields.");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain(">Dismiss<");
  });

  it("lists several block types and keeps other notices", () => {
    const html = render(["alpha", "zeta"], ["Review 1 same-page link (#…) by hand."]);
    expect(html).toContain("2 block types copied untranslated");
    expect(html).toContain("<code>alpha</code>, <code>zeta</code> aren't in blockFields.");
    expect(html).toContain("Review 1 same-page link");
  });

  it("keeps the generic title for other notices", () => {
    const html = render([], ["Review 1 same-page link (#…) by hand."]);
    expect(html).toContain("Check this translation");
    expect(html).not.toContain("blockFields");
  });
});
