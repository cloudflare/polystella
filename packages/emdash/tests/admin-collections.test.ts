import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CollectionRow, SubFieldPicker } from "../src/admin/plugin-page/tabs/CollectionsTab/CollectionsTab.js";
import type { SchemaField } from "../src/admin/types.js";
import type { CollectionPolicy } from "../src/contracts.js";

const field = (slug: string, label: string): SchemaField => ({
  id: slug,
  collectionId: "case_studies",
  slug,
  label,
  type: "string",
  columnType: "TEXT",
  required: false,
  unique: false,
  searchable: false,
  indexed: false,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});

// EmDash's admin types omit `validation.subFields`, though it sends them.
const repeater = (slug: string, label: string, subFields: Array<[string, string]>): SchemaField =>
  ({
    ...field(slug, label),
    type: "repeater",
    columnType: "JSON",
    validation: { subFields: subFields.map(([sub, subLabel]) => ({ slug: sub, label: subLabel, type: "string" })) },
  }) as unknown as SchemaField;

const quotes = repeater("pull_quotes", "Pull quotes", [
  ["quote", "Quote"],
  ["role", "Role"],
  ["author_name", "Author name"],
  ["link", "Link"],
]);

const fields = [
  field("title", "Title"),
  field("summary", "Summary"),
  field("body", "Body"),
  field("quote", "Quote"),
  field("seo_title", "SEO title"),
  field("author", "Author"),
];

function render(props: { saved?: boolean; open?: boolean; policy?: CollectionPolicy | undefined; fields?: SchemaField[] }): string {
  return renderToStaticMarkup(
    createElement(CollectionRow, {
      collection: { slug: "case_studies", label: "Case Studies" },
      saved: props.saved ?? true,
      first: true,
      policy: "policy" in props ? props.policy : { fields: ["title", "summary", "body", "quote", "seo_title"] },
      fields: props.fields ?? fields,
      schemaError: undefined,
      open: props.open ?? false,
      working: false,
      onEnabledChange: () => {},
      onOpenChange: () => {},
      onFieldsChange: () => {},
      onSubFieldsChange: () => {},
    }),
  );
}

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("collection rows", () => {
  it("shows a translated collection's first three fields as chips, then a count", () => {
    const html = render({});
    expect(text(html)).toContain("Title Summary Body +2");
    expect(html).toContain('aria-label="2 more fields: Quote, SEO title"');
    expect(html).not.toContain('title="Quote, SEO title"');
    expect(text(html)).toContain("Edit Case Studies fields");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Fields to translate");
  });

  it("opens the fields as toggle chips coloured like a switched-on Switch", () => {
    const html = render({ open: true });
    expect(text(html)).toContain("Close Case Studies fields");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear all");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(5);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Author<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*class="bg-blue-500 text-white dark:bg-blue-600"[^>]*>Title<\/button>/);
    expect(html).not.toContain("✓");
    expect(html).not.toContain("selected.");
  });

  it("keeps the editor open after Clear all, with the switch off", () => {
    const html = render({ open: true, policy: undefined });
    expect(html).toContain("Fields to translate");
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('aria-checked="false"');
  });

  it("lists a collection that isn't translated without chips or an editor", () => {
    const html = render({ saved: false, policy: undefined });
    expect(text(html)).not.toContain("+2");
    expect(text(html)).not.toContain("Edit Case Studies fields");
    expect(html).toContain("Edit Case Studies in Content types");
    expect(html).not.toContain("<strong>");
  });
});

describe("repeater subfields", () => {
  const withQuotes = (subFields: string[]) =>
    render({
      open: true,
      fields: [field("title", "Title"), quotes],
      policy: { fields: ["title", "pull_quotes"], subFields: { pull_quotes: subFields } },
    });

  it("shows a selected repeater's subfield count and a caret that opens them", () => {
    const html = withQuotes(["quote", "role"]);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Pull quotes · 2\/4<\/button>/);
    expect(html).toContain('aria-label="Pull quotes subfields"');
    expect(html).not.toContain("subfields to translate");
  });

  it("marks the chip when a chosen subfield looks like a link or name", () => {
    expect(withQuotes(["quote", "link"])).toContain('aria-label="Pull quotes subfields (needs a look)"');
  });

  it("has no caret while the repeater is off", () => {
    const html = render({ open: true, fields: [field("title", "Title"), quotes], policy: { fields: ["title"] } });
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Pull quotes<\/button>/);
    expect(html).not.toContain("Pull quotes subfields");
  });

  const picker = (target: SchemaField, chosen: string[]) =>
    renderToStaticMarkup(createElement(SubFieldPicker, { field: target, chosen, disabled: false, onChange: () => {} }));

  it("lists subfields by label with help behind an info button", () => {
    const html = picker(quotes, ["quote", "role"]);
    expect(text(html)).toContain("Pull quotes subfields");
    expect(html).toContain('aria-label="About Pull quotes subfields"');
    expect(text(html)).toContain("Author name");
    expect(text(html)).not.toContain("(author_name)");
    expect(text(html)).toContain("Select all");
    expect(text(html)).not.toContain("looks like a link");
  });

  it("keeps the identifier warning inside the popover", () => {
    expect(text(picker(quotes, ["quote", "link"]))).toContain("Link looks like a link, ID or name.");
  });

  it("drops Select all and Clear all for three subfields or fewer", () => {
    const small = repeater("results", "Key results", [["text", "Text"]]);
    expect(text(picker(small, ["text"]))).not.toContain("Select all");
  });
});
