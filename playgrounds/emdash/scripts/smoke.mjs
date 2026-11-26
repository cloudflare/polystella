#!/usr/bin/env node
// @ts-check
// Usage: node scripts/smoke.mjs <origin> [--real] [phase ...]   (see the README's "Smoke tests")
// Drives a running playground through the plugin's content, settings and batch routes and prints PASS/WARN/FAIL per check.
// WARN is a model that was refused or got something wrong: real models vary between runs, and a refusal saves nothing.
// Without --real it needs the server on the fake AI (free); with --real, on real Workers AI (costs a few cents).
// It writes drafts and jobs, turns on collection policies for posts and landing when none are set, and changes Translation
// settings (restored at the end), so use a playground you can reset.

import { fakeReasoningInput } from "../models.mjs";
import { connect, GuardError } from "./playground-client.mjs";

const FAKE_PHASES = ["base", "tokens", "race"];
const REAL_PHASES = ["sweep", "truncate", "jobs"];
const usage = `usage: node scripts/smoke.mjs <origin> [--real] [phase ...]
  fake AI (free):  phases ${FAKE_PHASES.join(", ")} (default: base)
                   tokens needs the fake started with POLYSTELLA_FAKE_AI_MIN_TOKENS=4000, race with POLYSTELLA_FAKE_AI_DELAY_MS=3000
  real AI (costs): phases ${REAL_PHASES.join(", ")} (default: all)`;

const args = process.argv.slice(2);
const real = args.includes("--real");
const [origin, ...requested] = args.filter((argument) => argument !== "--real");
const known = real ? REAL_PHASES : FAKE_PHASES;
const phases = requested.length > 0 ? requested : real ? REAL_PHASES : ["base"];
if (origin === undefined || phases.some((phase) => !known.includes(phase))) {
  console.error(usage);
  process.exit(1);
}

const client = await connect(origin).catch((error) => {
  if (!(error instanceof GuardError)) throw error;
  console.error(error.message);
  process.exit(1);
});
const { api, plugin, pluginRequest } = client;

const tally = { PASS: 0, WARN: 0, FAIL: 0 };
/** @param {string} name @param {boolean} ok @param {string} [detail] @param {"FAIL" | "WARN"} [otherwise] */
function check(name, ok, detail = "", otherwise = "FAIL") {
  const outcome = ok ? "PASS" : otherwise;
  tally[outcome]++;
  console.log(`${outcome}${outcome === "WARN" ? " " : "  "}${name}${detail === "" ? "" : `   [${detail}]`}`);
}
const sleep = (/** @type {number} */ milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const text = (/** @type {unknown} */ value) => JSON.stringify(value) ?? "";

/** The message a refused call carries, or null when the call was accepted. */
async function refused(/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) {
  const result = await pluginRequest(method, path, body);
  return result.ok ? null : String(result.error?.message ?? `HTTP ${result.status}`);
}

async function findEntryId(/** @type {string} */ collection, /** @type {string} */ locale, /** @type {string} */ slug) {
  const data = await api("GET", `/content/${collection}?locale=${locale}&limit=100`);
  return data.items.find((/** @type {{ slug: string }} */ item) => item.slug === slug)?.id;
}
async function entryId(/** @type {string} */ collection, /** @type {string} */ locale, /** @type {string} */ slug) {
  const id = await findEntryId(collection, locale, slug);
  if (id === undefined)
    throw new Error(`${collection}/${slug} (${locale}) is missing; reset the database and open the dev-bypass URL again`);
  return id;
}
const entry = async (/** @type {string} */ collection, /** @type {string} */ id) => (await api("GET", `/content/${collection}/${id}`)).item;

async function waitFor(/** @type {string} */ jobId, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = (await plugin("GET", "batch/jobs")).jobs.find((/** @type {{ id: string }} */ item) => item.id === jobId);
    if (job === undefined) throw new Error(`job ${jobId} is not in the job list`);
    if (job.status !== "running") return job;
    await sleep(500);
  }
  throw new Error(`job ${jobId} was still running after ${timeoutMs / 1000}s`);
}

/** The body the settings route expects for `current`, with `changes` on top. */
function settingsBody(/** @type {any} */ current, /** @type {Record<string, unknown>} */ changes = {}) {
  return {
    revision: current.revision,
    debugEnabled: current.debugEnabled,
    clearAiFlagOnEdit: current.clearAiFlagOnEdit,
    translateSeoWhenPublished: current.translateSeoWhenPublished,
    maxTokens: current.maxTokens,
    model: current.model,
    reasoning: current.reasoning,
    locales: Object.fromEntries(
      current.locales.map((/** @type {any} */ locale) => [
        locale.locale,
        { model: locale.model, reasoning: locale.reasoning, glossaryMode: locale.glossaryMode, glossaryText: locale.glossaryText },
      ]),
    ),
    instructions: { mode: current.instructions.mode, text: current.instructions.text },
    ...changes,
  };
}
async function putSettings(/** @type {Record<string, unknown>} */ changes) {
  await plugin("PUT", "settings/translation", settingsBody(await plugin("GET", "settings/translation"), changes));
}

/** @param {any[]} blocks @returns {string[]} */
function texts(blocks) {
  return (blocks ?? []).flatMap((block) => [
    ...(block.children ?? []).flatMap((/** @type {any} */ child) => (typeof child.text === "string" ? [child.text] : [])),
    ...(block.columns ?? []).flatMap((/** @type {any} */ column) => texts(column.content)),
  ]);
}

/** Does the server answer with the fake AI's "[locale] " echo? */
async function serverUsesFakeAi() {
  const settings = await plugin("GET", "settings/translation");
  const probe = await plugin("POST", "translation-sandbox", { text: "Hello", targetLocale: "ja-JP", model: settings.allowedModels[0] });
  return String(probe.translation).startsWith("[ja-JP] ");
}

async function enablePolicies() {
  const policies = await plugin("GET", "settings/collections");
  if (Object.keys(policies.policies).length > 0) return;
  await plugin("PUT", "settings/collections", {
    revision: policies.revision,
    policies: {
      posts: { fields: ["content", "excerpt", "faq", "title"], subFields: { faq: ["answer", "question"] } },
      landing: { fields: ["layout", "title"] },
    },
  });
}

/** Fails the run early when the allowed models can't support the checks. */
async function requireModels(/** @type {string[]} */ needed) {
  const { allowedModels } = await plugin("GET", "settings/translation");
  const missing = needed.filter((model) => !allowedModels.includes(model));
  if (missing.length > 0)
    throw new Error(`these checks need ${missing.join(", ")} in the allowed models. Unset POLYSTELLA_AI_MODELS to use the shipped list.`);
}

const GLM_FLASH = "@cf/zai-org/glm-4.7-flash";
const QWEN = "@cf/qwen/qwen3.8-27b";
const GLM_53 = "@cf/zai-org/glm-5.3";
const DEEPSEEK = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

async function base() {
  await requireModels([GLM_FLASH, QWEN, GLM_53, "@cf/openai/gpt-oss-120b", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]);
  const welcome = await entryId("posts", "en-US", "welcome");
  const partner = await entryId("posts", "en-US", "partner-update");
  const home = await entryId("landing", "en-US", "home");
  // A rerun finds the translation published by the last run, so unpublish it to start from the same state.
  const landingJa = await findEntryId("landing", "ja-JP", "home");
  if (landingJa !== undefined) await client.request("POST", `/content/landing/${landingJa}/unpublish`);

  console.log("\n-- default model and thinking in Translation settings");
  const current = await plugin("GET", "settings/translation");
  check("the code fallback is the first allowed model", current.defaultModel === current.allowedModels[0], current.defaultModel);
  check("no administrator model is picked", current.model === null);
  await putSettings({ model: GLM_FLASH, reasoning: "none", debugEnabled: true });
  const saved = await plugin("GET", "settings/translation");
  check("the administrator's default model and thinking are saved", saved.model === GLM_FLASH && saved.reasoning === "none");
  const fields = { collection: "posts", entryId: welcome, fields: ["title"] };
  const traced = await plugin("POST", "translate-content", { ...fields, targetLocale: "ja-JP" });
  check("every language uses the default model", traced.debug.model === GLM_FLASH, traced.debug.model);
  const requestInput = text(traced.debug.requestInput);
  check(
    "its thinking choice reaches the request",
    requestInput.includes("enable_thinking") && requestInput.includes("false"),
    requestInput.slice(0, 90),
  );
  const locales = settingsBody(saved).locales;
  locales["ar-SA"].model = QWEN;
  await putSettings({ locales });
  const arabic = await plugin("POST", "translate-content", { ...fields, targetLocale: "ar-SA" });
  const japanese = await plugin("POST", "translate-content", { ...fields, targetLocale: "ja-JP" });
  check("a language can still pick its own model", arabic.debug.model === QWEN && japanese.debug.model === GLM_FLASH);
  const unknownEffort = await refused(
    "PUT",
    "settings/translation",
    settingsBody(await plugin("GET", "settings/translation"), { model: "@cf/openai/gpt-oss-120b", reasoning: "none" }),
  );
  check("a thinking effort the model lacks is refused", unknownEffort !== null);

  console.log("\n-- notice for custom blocks that blockFields does not list");
  const notice = await plugin("POST", "translate-content", {
    collection: "posts",
    entryId: partner,
    targetLocale: "ja-JP",
    fields: ["title", "content"],
  });
  check("the notice names the custom block type", String(notice.notice ?? "").includes("partner.badge"), notice.notice);
  const clean = await plugin("POST", "translate-content", {
    collection: "posts",
    entryId: welcome,
    targetLocale: "ja-JP",
    fields: ["content"],
  });
  check("no notice for built-in or listed blocks", !clean.notice);

  console.log("\n-- server jobs: update existing translations");
  if (!(await plugin("GET", "batch/jobs")).queueEnabled) {
    console.log("skipped: this runtime has no queue binding. Run it against the Cloudflare dev server.");
    return;
  }
  const draft = await entryId("posts", "pt-BR", "bem-vindo");
  const before = (await entry("posts", draft)).data.title;
  const kept = await waitFor((await plugin("POST", "batch/start", { collection: "posts", locales: ["pt-BR"], entryIds: [welcome] })).id);
  check("without the option an existing translation is skipped", kept.counts.skipped === 1 && kept.counts.updated === 0, text(kept.counts));
  check("and its text is untouched", (await entry("posts", draft)).data.title === before);
  const updated = await waitFor(
    (await plugin("POST", "batch/start", { collection: "posts", locales: ["pt-BR"], entryIds: [welcome], updateExisting: true })).id,
  );
  check("with the option it is updated", updated.counts.updated === 1 && updated.updateExisting === true, text(updated.counts));
  check("the draft now holds the new translation", String((await entry("posts", draft)).data.title).startsWith("[pt-BR]"));

  console.log("\n-- run settings");
  const run = { model: QWEN, reasoning: "low", maxTokens: 6000, instructions: "Don't translate product names" };
  const job = await waitFor(
    (
      await plugin("POST", "batch/start", {
        collection: "landing",
        locales: ["ja-JP"],
        entryIds: [home],
        updateExisting: true,
        settings: run,
      })
    ).id,
  );
  check("the job keeps its run settings", text(job.settings) === text(run), text(job.settings));
  check("the job wrote the translation", job.counts.created + job.counts.updated === 1, text(job.counts));
  const landing = await entryId("landing", "ja-JP", "home");
  const flag = await plugin("GET", `ai-translation/status?collection=landing&entryId=${landing}`);
  check("the AI-translated flag records the model the run used", flag.aiTranslated === true && flag.model === QWEN, flag.model);
  const start = { collection: "landing", locales: ["ja-JP"], entryIds: [home] };
  check(
    "a model outside the allowed list is refused",
    (await refused("POST", "batch/start", { ...start, settings: { model: "@cf/nobody/x" } })) !== null,
  );
  check(
    "a thinking effort the model lacks is refused",
    (await refused("POST", "batch/start", {
      ...start,
      settings: { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", reasoning: "low" },
    })) !== null,
  );
  check("a token limit out of range is refused", (await refused("POST", "batch/start", { ...start, settings: { maxTokens: 5 } })) !== null);

  console.log("\n-- retry with redo");
  const redo = await waitFor(
    (await plugin("POST", "batch/retry", { jobId: job.id, redo: true, settings: { model: GLM_53, reasoning: "low" } })).id,
  );
  check("the retry is a new job linked to the original", redo.id !== job.id && redo.retryOf === job.id, redo.retryOf);
  check("redone rows show as updated", redo.counts.updated === 1, text(redo.counts));
  check("the retry has its own settings", redo.settings?.model === GLM_53);
  const redoneFlag = await plugin("GET", `ai-translation/status?collection=landing&entryId=${landing}`);
  check("the flag now records the retry's model", redoneFlag.model === GLM_53, redoneFlag.model);
  await client.request("POST", `/content/landing/${landing}/publish`);
  const skipped = await waitFor((await plugin("POST", "batch/retry", { jobId: redo.id, redo: true })).id);
  check(
    "a translation published since is skipped, not redone",
    skipped.counts.skipped === 1 && skipped.counts.updated === 0,
    text(skipped.counts),
  );
}

async function tokens() {
  console.log("\n-- retry failed rows with new run settings (the fake cuts replies below 4000 tokens)");
  if (!(await plugin("GET", "batch/jobs")).queueEnabled) return console.log("skipped: this runtime has no queue binding.");
  const launch = await entryId("posts", "en-US", "launch-notes");
  const start = { collection: "posts", locales: ["ar-SA"], entryIds: [launch], updateExisting: true };
  const failed = await waitFor((await plugin("POST", "batch/start", { ...start, settings: { maxTokens: 2048 } })).id);
  const message = failed.failures[0]?.message ?? "";
  check("a low token limit fails the row", failed.counts.failed === 1, text(failed.counts));
  check("the failure says why", message.includes("output tokens"), message.slice(0, 90));
  const fixed = await waitFor((await plugin("POST", "batch/retry", { jobId: failed.id, settings: { maxTokens: 8192 } })).id);
  check(
    "retrying with a higher limit succeeds",
    fixed.counts.created + fixed.counts.updated === 1 && fixed.counts.failed === 0 && fixed.retryOf === failed.id,
    text(fixed.counts),
  );
  check("the retry kept the new limit", fixed.settings?.maxTokens === 8192);
}

async function race() {
  console.log("\n-- an edit made while a server job translates is not overwritten (the fake delays 3 s)");
  if (!(await plugin("GET", "batch/jobs")).queueEnabled) return console.log("skipped: this runtime has no queue binding.");
  const welcome = await entryId("posts", "en-US", "welcome");
  const draft = await entryId("posts", "pt-BR", "bem-vindo");
  const job = await plugin("POST", "batch/start", { collection: "posts", locales: ["pt-BR"], entryIds: [welcome], updateExisting: true });
  await sleep(1000);
  const running = (await plugin("GET", "batch/jobs")).jobs.find((/** @type {{ id: string }} */ item) => item.id === job.id);
  check("the job is running while the AI is slow", running.status === "running");
  const { _rev } = await api("GET", `/content/posts/${draft}`);
  const saved = await client.request("PUT", `/content/posts/${draft}`, { data: { title: "Edited by a person" }, _rev });
  check("an editor saved the draft meanwhile", saved.ok, `${saved.status} ${text(saved.error)}`);
  const done = await waitFor(job.id);
  check("the row was skipped, not overwritten", done.counts.skipped === 1 && done.counts.updated === 0, text(done.counts));
  check("the editor's text survived", (await entry("posts", draft)).data.title === "Edited by a person");

  console.log("\n-- cancel a running job");
  const slow = await plugin("POST", "batch/start", { collection: "posts", locales: ["ja-JP", "ar-SA"], updateExisting: true });
  await sleep(500);
  const cancelled = await plugin("POST", "batch/cancel", { jobId: slow.id });
  check("the job is cancelled", cancelled.status === "cancelled", cancelled.status);
}

const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;
const ARABIC = /[\u0600-\u06ff]/;

async function sweep() {
  const welcome = await entryId("posts", "en-US", "welcome");
  const models = (await plugin("GET", "settings/translation")).allowedModels;
  console.log(`\n-- ${models.length} models, thinking off where the model allows, 4096 max output tokens`);
  for (const model of models) {
    const name = model.split("/").at(-1);
    const live = (await plugin("GET", `models/reasoning?model=${encodeURIComponent(model)}`)).efforts;
    const offline = Object.hasOwn(fakeReasoningInput, model)
      ? Object.keys(fakeReasoningInput[/** @type {keyof typeof fakeReasoningInput} */ (model)])
      : [];
    check(
      `thinking choices match models.mjs: ${name}`,
      [...(live ?? [])].sort().join() === [...offline].sort().join(),
      `live=${text(live)} offline=${text(offline)}`,
    );
    const effort = ["none", "minimal", "low"].find((choice) => live?.includes(choice)) ?? null;
    await putSettings({ model, reasoning: effort, maxTokens: 4096, debugEnabled: true });
    const started = Date.now();
    const result = await pluginRequest("POST", "translate-content", {
      collection: "posts",
      entryId: welcome,
      targetLocale: "ja-JP",
      fields: ["title", "excerpt", "content", "faq"],
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const patch = result.data?.patch;
    if (!result.ok || !patch) {
      check(
        `${name} translates the welcome post`,
        false,
        `${seconds}s, thinking=${effort}: ${String(result.error?.message ?? result.data?.error ?? "no patch").slice(0, 160)}`,
        "WARN",
      );
      continue;
    }
    const flat = texts(patch.content).join(" ");
    const code = patch.content.find((/** @type {any} */ block) => block._type === "code");
    const buttons = patch.content.find((/** @type {any} */ block) => block._type === "buttons");
    // Text the model was never sent cannot change, so a change there is the plugin's fault. The rest is the model's.
    const broken = [
      code?.code !== 'const greeting = t("home.greeting", { name: "Ada" });' && "the code block changed",
      text(buttons?.buttons?.map((/** @type {any} */ button) => button.url)) !==
        text(["https://docs.emdashcms.com/", "https://github.com/cloudflare/polystella"]) && "button URLs changed",
      text((patch.faq ?? []).map((/** @type {any} */ row) => row.source)) !==
        text(["https://docs.emdashcms.com/", "https://example.com/links"]) && "FAQ source URLs changed",
    ].filter(Boolean);
    const weak = [
      !CJK.test(patch.title) && "title is not Japanese",
      !patch.title.includes("PolyStella") && "PolyStella lost from the title",
      !patch.excerpt.includes("{{token}}") && "{{token}} lost from the excerpt",
      !flat.includes("{{name}}") && "{{name}} lost from the content",
      !flat.includes("EmDash") && "EmDash lost from the content",
    ].filter(Boolean);
    const detail = `${seconds}s, thinking=${effort}`;
    check(
      `${name} leaves code, button URLs and FAQ sources alone`,
      broken.length === 0,
      broken.length > 0 ? `${detail}: ${broken.join("; ")}` : detail,
    );
    check(
      `${name} keeps placeholders, names and the language`,
      weak.length === 0,
      weak.length > 0 ? `${detail}: ${weak.join("; ")}` : detail,
      "WARN",
    );
  }
}

async function truncate() {
  await requireModels([DEEPSEEK]);
  const welcome = await entryId("posts", "en-US", "welcome");
  console.log("\n-- truncation and recovery with a real model");
  const body = { collection: "posts", entryId: welcome, targetLocale: "ja-JP", fields: ["title", "excerpt", "content", "faq"] };
  await putSettings({ model: DEEPSEEK, reasoning: "high", maxTokens: 256, debugEnabled: true });
  const cut = await pluginRequest("POST", "translate-content", body);
  const message = String(cut.error?.message ?? cut.data?.error ?? "");
  check(
    "a 256 token limit with high thinking fails with the out-of-tokens message",
    message.includes("output tokens"),
    message.slice(0, 140),
  );
  await putSettings({ model: DEEPSEEK, reasoning: "none", maxTokens: 4096, debugEnabled: true });
  const fine = await pluginRequest("POST", "translate-content", body);
  check("raising the limit and turning thinking off succeeds", Boolean(fine.data?.patch), String(fine.error?.message ?? ""), "WARN");
}

async function jobs() {
  console.log("\n-- real server-queue jobs with run settings");
  if (!(await plugin("GET", "batch/jobs")).queueEnabled)
    return console.log("skipped: this runtime has no queue binding. Run it against the Cloudflare dev server.");
  await requireModels([DEEPSEEK, GLM_53]);
  const welcome = await entryId("posts", "en-US", "welcome");
  await putSettings({ model: DEEPSEEK, reasoning: "none", maxTokens: 8192 });
  const run = { model: DEEPSEEK, reasoning: "low", maxTokens: 8192, instructions: "Keep the English word 'demo' untranslated." };
  const job = await waitFor(
    (
      await plugin("POST", "batch/start", {
        collection: "posts",
        locales: ["ja-JP", "ar-SA"],
        entryIds: [welcome],
        updateExisting: true,
        settings: run,
      })
    ).id,
  );
  check(
    "the job translated both languages",
    job.counts.created + job.counts.updated === 2 && job.counts.failed === 0,
    `${text(job.counts)} ${text(job.failures)}`,
    "WARN",
  );
  check("the run settings were accepted against the live catalogue", text(job.settings) === text(run));
  // A row that failed leaves an older translation behind, so only judge the rows this job wrote.
  const wrote = (/** @type {string} */ locale) =>
    !job.failures.some((/** @type {{ locale: string }} */ failure) => failure.locale === locale);
  const written = async (/** @type {string} */ locale) => {
    const id = wrote(locale) ? await findEntryId("posts", locale, "welcome") : undefined;
    return id === undefined ? undefined : entry("posts", id);
  };
  const ja = await written("ja-JP");
  const ar = await written("ar-SA");
  check(
    "Japanese output has Japanese text and keeps PolyStella",
    CJK.test(ja?.data.title ?? "") && ja.data.title.includes("PolyStella"),
    ja?.data.title ?? "no ja-JP translation from this job",
    "WARN",
  );
  check(
    "Arabic output has Arabic text and keeps PolyStella",
    ARABIC.test(ar?.data.title ?? "") && ar.data.title.includes("PolyStella"),
    ar?.data.title ?? "no ar-SA translation from this job",
    "WARN",
  );
  console.log(
    `      the instruction kept 'demo' in English? ja: ${ja?.data.title.toLowerCase().includes("demo")}  ar: ${ar?.data.title.toLowerCase().includes("demo")}  (informational)`,
  );
  const saved = ja ?? ar;
  if (saved === undefined) return console.log("      no row was saved, so the flag and redo checks are skipped");
  const flag = await plugin("GET", `ai-translation/status?collection=posts&entryId=${saved.id}`);
  check("the AI-translated flag records the model", flag.model === DEEPSEEK, flag.model);
  const redo = await waitFor(
    (await plugin("POST", "batch/retry", { jobId: job.id, redo: true, settings: { model: GLM_53, reasoning: "low", maxTokens: 8192 } })).id,
  );
  check(
    "redo with another model rewrites the rows that were saved",
    redo.counts.updated >= 1 && redo.retryOf === job.id,
    `${text(redo.counts)} ${text(redo.failures)}`,
    "WARN",
  );
  const redoneFlag = await plugin("GET", `ai-translation/status?collection=posts&entryId=${saved.id}`);
  check("the flag now records the redo model", redoneFlag.model === GLM_53, redoneFlag.model, redo.failures.length === 0 ? "FAIL" : "WARN");
}

// What the server does is checked before anything is written or spent.
const usesFake = await serverUsesFakeAi();
if (real && usesFake) {
  console.error("This server is using the fake AI. Start it with POLYSTELLA_AI=real to run the real checks.");
  process.exit(1);
}
if (!real && !usesFake) {
  console.error(
    "This server is calling real Workers AI, so these checks would spend money. Run `smoke:real`, or restart the server on the fake AI.",
  );
  process.exit(1);
}
if (real) console.log("Real mode: these checks send real requests to Workers AI and cost a few cents.");

await enablePolicies();
const original = await plugin("GET", "settings/translation");
const runners = /** @type {Record<string, () => Promise<unknown>>} */ ({ base, tokens, race, sweep, truncate, jobs });
try {
  for (const phase of phases) {
    await runners[phase]?.().catch((/** @type {unknown} */ error) =>
      check(`the ${phase} phase ran to the end`, false, error instanceof Error ? error.message : String(error)),
    );
  }
} finally {
  // The checks change Translation settings; put back what was there.
  await plugin("GET", "settings/translation")
    .then((latest) => plugin("PUT", "settings/translation", settingsBody(original, { revision: latest.revision })))
    .catch((error) => check("Translation settings were restored", false, error instanceof Error ? error.message : String(error)));
}
console.log(`\n${tally.PASS} passed, ${tally.WARN} warnings, ${tally.FAIL} failed`);
process.exit(tally.FAIL === 0 ? 0 : 1);
