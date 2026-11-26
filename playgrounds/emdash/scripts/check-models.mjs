#!/usr/bin/env node
// @ts-check
// Usage: node scripts/check-models.mjs [model-id ...]   (default: the list in models.mjs)
// Checks each model against the public Workers AI catalogue: it exists, is not deprecated, and takes `messages` and `max_tokens`.
// The catalogue is the cloudflare-docs repo, which can lag the live one. Exits 1 when a model has a problem, 2 when the catalogue can't be read.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CATALOGUE_URL =
  process.env.POLYSTELLA_CATALOGUE_URL ??
  "https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models";
const SOON_DAYS = 60;
const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;

/** The property sets a request may use: allOf parts and a node's own properties combine, oneOf and anyOf are alternatives. */
/** @param {unknown} part @returns {Array<{ properties: Record<string, unknown> }>} */
function schemaLeaves(part) {
  if (typeof part !== "object" || part === null) return [];
  const record = /** @type {Record<string, unknown>} */ (part);
  const own = typeof record.properties === "object" && record.properties !== null ? record.properties : {};
  const allOf = Array.isArray(record.allOf) ? record.allOf.flatMap(schemaLeaves).map((leaf) => leaf.properties) : [];
  const shared = Object.assign({}, own, ...allOf);
  const alternatives = ["oneOf", "anyOf"].flatMap((key) => (Array.isArray(record[key]) ? record[key].flatMap(schemaLeaves) : []));
  if (alternatives.length > 0) return alternatives.map((leaf) => ({ properties: { ...shared, ...leaf.properties } }));
  return Object.keys(shared).length > 0 ? [{ properties: shared }] : [];
}

/**
 * @param {string} id
 * @param {any} doc The catalogue entry, or null when there is none.
 * @param {Date} [today]
 * @returns {{ problems: string[]; warnings: string[] }}
 */
export function checkModel(id, doc, today = new Date()) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  if (doc === null || doc === undefined) return { problems: ["not in the catalogue"], warnings };
  if (doc.name !== id) problems.push(`the catalogue lists it as ${doc.name}`);
  if (doc.deprecated === true) problems.push("marked deprecated");

  const properties = Array.isArray(doc.properties) ? doc.properties : [];
  /** @param {string} propertyId */
  const property = (propertyId) => properties.find((/** @type {{ property_id: string }} */ item) => item.property_id === propertyId)?.value;
  const planned = property("planned_deprecation_date");
  if (typeof planned === "string") {
    const date = Date.parse(planned);
    const days = Math.ceil((date - today.getTime()) / DAY_MS);
    if (Number.isNaN(date)) warnings.push(`unreadable planned_deprecation_date "${planned}"`);
    else if (days <= 0) problems.push(`deprecation was planned for ${planned}`);
    else if (days <= SOON_DAYS) warnings.push(`deprecation planned for ${planned}, in ${days} days`);
  }
  const effort = property("reasoning_effort");
  if (typeof effort === "object" && effort !== null && effort.supports_max_tokens === false) {
    warnings.push("the catalogue says reasoning_effort does not support max_tokens, so a token limit may not apply");
  }
  if (doc.task?.name !== "Text Generation") problems.push(`task is ${doc.task?.name ?? "unknown"}, not Text Generation`);

  const input = schemaLeaves(doc.schema?.input);
  if (input.length === 0) problems.push("no published schema (it may need an access request)");
  else if (!input.some((leaf) => "messages" in leaf.properties && "max_tokens" in leaf.properties)) {
    problems.push("no documented input with both messages and max_tokens");
  }
  if (input.length > 0 && schemaLeaves(doc.schema?.output).length === 0) warnings.push("reply shape is undocumented");
  return { problems, warnings };
}

/** @param {string} id @returns {Promise<any>} */
async function fetchEntry(id) {
  const response = await fetch(`${CATALOGUE_URL}/${id.split("/").at(-1)}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.url} answered ${response.status}`);
  return response.json();
}

function runAsScript() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : (await import("../models.mjs")).allowedModels;
  let entries;
  try {
    entries = await Promise.all(ids.map(fetchEntry));
  } catch (error) {
    console.error(`could not read the catalogue: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  let failed = 0;
  ids.forEach((id, index) => {
    const { problems, warnings } = checkModel(id, entries[index]);
    if (problems.length > 0) failed += 1;
    const status = problems.length > 0 ? "FAIL" : warnings.length > 0 ? "warn" : "ok  ";
    console.log(`${status}  ${id}${[...problems, ...warnings].map((note) => `\n        ${note}`).join("")}`);
  });
  console.log(`\n${ids.length} models, ${failed} with problems (source: ${CATALOGUE_URL})`);
  process.exit(failed > 0 ? 1 : 0);
}
