import { jsonAdapter as portableJsonAdapter, type JsonData } from "@cloudflare/polystella-adapters";
import { createStructuredAstroAdapter } from "../adapter.js";

/**
 * JSON adapter. Parses with the native `JSON.parse`, extracts
 * translatable scalars at user-configured key paths (with wildcard
 * support), and applies translations by mutating the parsed
 * structure and re-stringifying with a stable two-space indent.
 *
 * **Round-trip fidelity (relaxed).** JSON has no comments, but key
 * order, indentation, and trailing-newline conventions in the source
 * are NOT preserved. `JSON.stringify(_, null, 2)` produces canonical
 * output. Source files are never rewritten by polystella, so this
 * only affects translation outputs (regenerated each build).
 *
 * **Cache key.** Uses the same body+selectedValues+glossary+model
 * hash composition as the markdown / TOML adapters today; whitespace
 * in source files DOES bust the cache. The structured-data variant
 * (drop `rawBody`, hash only canonical selected values) is documented
 * as future work in the design doc §3.1.
 *
 * **noTranslate opt-out.** Top-level boolean `noTranslate: true`
 * skips the file. JSON's strict type system means no string aliases
 * (matching TOML; YAML's looser parsing accepts `"true"` / `"yes"`
 * for parity with markdown frontmatter).
 *
 * **AI-marker injection (per-entry, not file root).** Astro's
 * `file()` loader maps each top-level JSON key to a separate
 * collection entry, with the value as that entry's `data`. Marker
 * fields written at the file root would manifest as bogus extra
 * entries (e.g. an entry with id `aiTranslated` whose data is
 * `true`) and fail schema validation. The adapter therefore injects
 * the marker fields INSIDE each top-level object-valued key — top-
 * level scalar keys are skipped (their values are already valid
 * entry data and the marker has nowhere meaningful to attach).
 *
 * **Top-level array handling.** A JSON file with a top-level array
 * (Astro maps each array element to a collection entry by `id` /
 * `slug`) gets the marker injected into each element that's an
 * object — same intent as the per-key injection for object roots.
 */
export const jsonAdapter = createStructuredAstroAdapter(portableJsonAdapter, (parsed: JsonData) => {
  return (
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as Record<string, unknown>).noTranslate === true
  );
});
