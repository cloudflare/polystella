import { tomlAdapter as portableTomlAdapter, type TomlData } from "@cloudflare/polystella-adapters";
import { createStructuredAstroAdapter } from "../adapter.js";

/**
 * TOML adapter. Parses with `smol-toml`, extracts translatable
 * scalars at user-configured key paths (with wildcard support), and
 * applies translations by mutating the parsed structure and
 * re-stringifying.
 *
 * **Round-trip fidelity (relaxed).** Comments and exact key ordering
 * are not preserved on output — `smol-toml.stringify` produces clean
 * canonical TOML. This is acceptable for translation outputs (the
 * staged file is regenerated each build); source files are never
 * rewritten by polystella.
 *
 * **Cache key.** Today the runtime feeds raw body bytes + selected
 * values into `computeSourceHash`. For TOML that means whitespace
 * and comment edits in source files DO bust the cache; design doc
 * §3.1 calls out a structured-data variant that drops `rawBody` and
 * hashes `canonicalSelectedValues + glossary + model`. Implementing
 * that variant is M3.5 follow-up work — for v0.1.x ship, the
 * conservative current behaviour is fine.
 *
 * **noTranslate opt-out.** Top-level boolean `noTranslate = true`
 * skips the file. (No string aliases — TOML's stricter type system
 * doesn't need them, unlike YAML frontmatter.)
 *
 * **AI-marker injection (per-entry, not file root).** Astro's
 * `file()` loader maps each top-level TOML key to a separate
 * collection entry, with the value as that entry's `data`. Marker
 * fields written at the file root would manifest as bogus extra
 * entries (e.g. an entry with id `aiTranslated` whose data is
 * `true`) and fail schema validation. The adapter therefore injects
 * the marker fields INSIDE each top-level object-valued key — so a
 * file like `[main.featuredResearch]\n...` becomes `[main]\n
 * aiTranslated = true\n[main.featuredResearch]\n...` after
 * translation. Top-level scalar keys (numbers / booleans / strings)
 * are left untouched: they're already entries with non-object data
 * and the marker has nowhere meaningful to live on them. Files with
 * a single top-level key (the common `file()` loader case) get the
 * marker on that key; multi-entry files get it on each one.
 *
 * Consumer schemas extended by `polystellaCollections` accept these
 * fields uniformly across formats — TOML siblings work identically
 * to markdown siblings on the consumer side.
 */
export const tomlAdapter = createStructuredAstroAdapter(portableTomlAdapter, (parsed: TomlData) => parsed.noTranslate === true);
