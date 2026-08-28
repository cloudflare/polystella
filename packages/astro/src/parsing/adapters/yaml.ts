import { yamlAdapter as portableYamlAdapter, type YamlData } from "@cloudflare/polystella-adapters";
import { createStructuredAstroAdapter } from "../adapter.js";

/**
 * YAML adapter. Parses with the `yaml` library (already a dep for
 * markdown frontmatter), extracts translatable scalars at user-
 * configured key paths (with wildcard support), and applies
 * translations by mutating the parsed structure and re-stringifying.
 *
 * **Round-trip fidelity (relaxed).** Comments, anchors / aliases,
 * exact key ordering, and quoting style are NOT preserved on output
 * — `yaml.stringify` produces canonical output. Source files are
 * never rewritten by polystella, so this only affects translation
 * outputs (regenerated each build). Document mode (which preserves
 * more structure) is on the table for future strict round-trip; the
 * v0.1.x ship uses the simpler parse/stringify path.
 *
 * **Cache key.** Uses the same body+selectedValues+glossary+model
 * hash composition as the markdown / TOML / JSON adapters today;
 * whitespace and comment edits in source files DO bust the cache.
 * The structured-data variant (drop `rawBody`, hash only canonical
 * selected values) is documented as future work in the design doc
 * §3.1.
 *
 * **noTranslate opt-out.** Top-level `noTranslate` accepts both
 * boolean `true` and the string aliases `"true"` / `"yes"` (matching
 * markdown frontmatter, which IS YAML — operators expect parity
 * across the two YAML surfaces). TOML and JSON are stricter.
 *
 * **AI-marker injection (per-entry, not file root).** Astro's
 * `file()` loader maps each top-level YAML key to a separate
 * collection entry, with the value as that entry's `data`. Marker
 * fields written at the file root would manifest as bogus extra
 * entries (e.g. an entry with id `aiTranslated` whose data is
 * `true`) and fail schema validation. The adapter therefore injects
 * the marker fields INSIDE each top-level object-valued key. Top-
 * level scalar keys are skipped (their values are already valid
 * entry data and the marker has nowhere meaningful to attach).
 *
 * **Top-level sequence handling.** A YAML file with a top-level
 * sequence (Astro maps each element to a collection entry by
 * `id` / `slug`) gets the marker injected into each element that's
 * a mapping — same intent as the per-key injection for mapping
 * roots.
 *
 * **Date / timestamp interop.** This adapter uses the `yaml`
 * package (eemeli/yaml v2), which returns unquoted ISO 8601 strings
 * as plain strings — quoted and unquoted forms hash identically in
 * `selectedValuesForHash`. Astro's `file()` loader, however, uses
 * `js-yaml` internally, which DOES auto-parse unquoted ISO
 * timestamps to `Date`. The schema-extender accommodates both:
 * `aiTranslatedAt: z.union([z.string(), z.date()])`, so the marker
 * round-trips correctly through both ends of the pipeline.
 */
export const yamlAdapter = createStructuredAstroAdapter(portableYamlAdapter, (parsed: YamlData) => {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const value = (parsed as Record<string, unknown>).noTranslate;
  if (value === true) return true;
  return typeof value === "string" && ["true", "yes"].includes(value.toLowerCase().trim());
});
