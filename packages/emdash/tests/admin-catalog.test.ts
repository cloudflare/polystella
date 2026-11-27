import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_CATALOG_KEYS, type CatalogEntryView } from "../src/contracts.js";
import { CatalogGroupCard } from "../src/admin/plugin-page/tabs/CatalogTab/CatalogTab.js";
import {
  applyOverridesInfo,
  catalogActionHint,
  filterCatalogGroups,
  groupCatalogEntries,
  listKeys,
  shortenText,
} from "../src/admin/plugin-page/tabs/CatalogTab/helpers.js";
import { shortModelName } from "../src/admin/utils.js";

function entry(key: string, overrides: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return { key, source: `Source ${key}`, deployed: null, override: null, state: null, ...overrides };
}

describe("catalog search", () => {
  const groups = groupCatalogEntries(
    [entry("nav.home"), entry("nav.about"), entry("footer.home"), entry("footer.legal")],
    [{ key: "nav", title: "Navigation" }],
  );

  it("keeps only matching entries inside a group matched by its entries", () => {
    const result = filterCatalogGroups(groups, "about");
    expect(result.map((group) => [group.key, group.entries.map((item) => item.key)])).toEqual([["nav", ["nav.about"]]]);
    expect(filterCatalogGroups(groups, "home").flatMap((group) => group.entries.map((item) => item.key))).toEqual([
      "footer.home",
      "nav.home",
    ]);
  });

  it("keeps every entry when the group title or key matches", () => {
    expect(filterCatalogGroups(groups, "navig")[0]?.entries).toHaveLength(2);
    expect(filterCatalogGroups(groups, "footer")[0]?.entries).toHaveLength(2);
  });
});

describe("catalog search edges", () => {
  const groups = groupCatalogEntries(
    [entry("nav.home", { source: "Welcome" }), entry("nav.about", { source: null }), entry("footer.legal", { source: "Terms" })],
    [{ key: "nav", title: "Navigation" }],
  );
  const keys = (query: string) => filterCatalogGroups(groups, query).map((group) => [group.key, group.entries.map((item) => item.key)]);

  it("shows every group for an empty or whitespace-only search", () => {
    expect(filterCatalogGroups(groups, "")).toEqual(groups);
    expect(filterCatalogGroups(groups, "   ")).toEqual(groups);
  });

  it("matches the source text case-insensitively, ignores null sources, and drops groups with no match", () => {
    expect(keys("  WELCOME ")).toEqual([["nav", ["nav.home"]]]);
    expect(keys("terms")).toEqual([["footer", ["footer.legal"]]]);
    expect(keys("zzz")).toEqual([]);
  });

  it("does not change the groups it filters", () => {
    filterCatalogGroups(groups, "welcome");
    expect(groups.find((group) => group.key === "nav")?.entries).toHaveLength(2);
  });
});

describe("catalog messages", () => {
  it("lists at most five keys", () => {
    expect(listKeys(["a", "b"])).toBe("a, b");
    expect(listKeys(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more");
  });

  it("says 'and N more' only past the limit", () => {
    const keys = ["a", "b", "c", "d", "e", "f"];
    expect(listKeys(keys.slice(0, 5))).toBe("a, b, c, d, e");
    expect(listKeys(keys)).toBe("a, b, c, d, e and 1 more");
    expect(listKeys(keys, 2)).toBe("a, b and 4 more");
    expect(listKeys([])).toBe("");
  });

  it("shortens long text with an ellipsis", () => {
    expect(shortenText("short", 10)).toBe("short");
    expect(shortenText("a long sentence", 7)).toBe("a long…");
  });

  it("explains disabled actions", () => {
    expect(catalogActionHint({ unsaved: 0, selected: 2, isDefaultLocale: false, hasSynced: true })).toBeNull();
    expect(catalogActionHint({ unsaved: 0, selected: 0, isDefaultLocale: false, hasSynced: false })).toBe(
      "Select keys to generate. No synced overrides to clear.",
    );
    expect(catalogActionHint({ unsaved: 3, selected: 1, isDefaultLocale: true, hasSynced: false })).toContain("Save or discard");
  });

  it("hints at the source locale, and hides the synced note while changes are unsaved", () => {
    const sourceHint = "This is the source locale, so nothing can be generated; pick another locale.";
    expect(catalogActionHint({ unsaved: 0, selected: 0, isDefaultLocale: true, hasSynced: true })).toBe(sourceHint);
    expect(catalogActionHint({ unsaved: 1, selected: 0, isDefaultLocale: false, hasSynced: false })).not.toContain("No synced");
    expect(catalogActionHint({ unsaved: 1, selected: 0, isDefaultLocale: false, hasSynced: false })).toContain("Select keys to generate.");
  });

  it("shortens Workers AI model ids", () => {
    expect(shortModelName("@cf/meta/llama-3.1-8b-instruct")).toBe("llama-3.1-8b-instruct");
    expect(shortModelName("gpt-4o")).toBe("gpt-4o");
  });
});

describe("catalog group card", () => {
  const [group] = groupCatalogEntries(
    [
      entry("nav.home", { override: "Accueil", deployed: "Accueil", state: "synced" }),
      entry("nav.about", { override: "À propos", state: "missing" }),
      entry("nav.blog"),
    ],
    [{ key: "nav", title: "Navigation" }],
  );

  function render(narrow: boolean, options: { selected?: string[]; touched?: string[]; overridesApplied?: boolean } = {}): string {
    if (group === undefined) throw new Error("missing group");
    const selected = options.selected ?? [];
    return renderToStaticMarkup(
      createElement(CatalogGroupCard, {
        group,
        narrow,
        headingRef: createRef<HTMLHeadingElement>(),
        messageSyntax: "polystella",
        selectedKeys: new Set(selected),
        selectionFull: selected.length >= MAX_CATALOG_KEYS,
        drafts: new Map([
          ["nav.home", "Accueil"],
          ["nav.about", "À propos"],
        ]),
        enabledOverrides: new Set(["nav.home", "nav.about"]),
        touchedKeys: new Set(options.touched ?? []),
        overridesApplied: options.overridesApplied ?? true,
        working: false,
        onToggleSelected: () => {},
        onToggleOverride: () => {},
        onDraftChange: () => {},
      }),
    );
  }

  it.each([false, true])("names controls per key and collapses untouched editors (narrow: %s)", (narrow) => {
    const html = render(narrow, { touched: ["nav.about"] });
    expect(html).toContain('aria-label="Navigation catalog keys"');
    expect(html).toContain('aria-label="Enable override for nav.home"');
    expect(html).toContain('aria-label="Override value for nav.about"');
    expect(html).not.toContain('aria-label="Override value for nav.home"');
    expect(html).toContain('aria-label="Edit override for nav.home"');
    expect(html).toContain("Synced");
    expect(html).toContain("Unsaved");
    expect(html).not.toContain("Not applied");
    expect(html).toContain(narrow ? "<ul" : "<table");
  });

  it("names the current translation column and marks keys it lacks", () => {
    const html = render(false);
    expect(html).toContain("Current translation");
    expect(html).not.toContain("Deployed");
    expect(html).toContain("Missing");
  });

  it.each([false, true])("marks saved overrides not applied only while Apply overrides is off (narrow: %s)", (narrow) => {
    const notApplied = (html: string) => html.match(/Not applied/g)?.length ?? 0;
    // nav.home and nav.about are saved; nav.blog has no override; the touched row shows Unsaved instead.
    expect(notApplied(render(narrow, { overridesApplied: false }))).toBe(2);
    expect(notApplied(render(narrow, { overridesApplied: false, touched: ["nav.about"] }))).toBe(1);
    expect(notApplied(render(narrow, { overridesApplied: true }))).toBe(0);
    expect(render(narrow, { overridesApplied: false })).toContain("opacity:0.5");
    expect(render(narrow, { overridesApplied: true })).not.toContain("opacity:0.5");
  });

  it("explains Apply overrides for the saved setting", () => {
    expect(applyOverridesInfo(true, 3)).toBe("On: the site shows the saved overrides instead of the current translations.");
    expect(applyOverridesInfo(false, 3)).toBe(
      "Off: the site shows its current translations. The 3 saved overrides are kept, but not shown on the site until you turn this on.",
    );
    expect(applyOverridesInfo(false, 1)).toContain("The saved override is kept, but not shown");
    expect(applyOverridesInfo(false, 0)).toBe("Off: the site shows its current translations. Save an override first to turn this on.");
  });

  it("explains a full selection", () => {
    const full = Array.from({ length: MAX_CATALOG_KEYS }, (_, index) => `other.${index}`);
    expect(render(false, { selected: full })).toContain("the most one request can generate");
    expect(render(false)).not.toContain("the most one request can generate");
  });
});
