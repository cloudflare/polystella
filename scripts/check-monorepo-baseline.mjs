#!/usr/bin/env node
// @ts-check

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { cleanupCommands, runCommand } from "./run-command.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const playgroundRoot = path.join(repositoryRoot, "playgrounds", "mdx-jsx");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const astroManifest = JSON.parse(await readFile(path.join(repositoryRoot, "packages", "astro", "package.json"), "utf8"));
if (typeof astroManifest.version !== "string") throw new Error("Astro package version is missing");
const polystellaVersion = astroManifest.version;

const dryRunHashes = {
  "docs/block-jsx.mdx": "1bd2533d354aac689865d610b9ef2c660a940eba7df2d02b3b01c4dee9a8081c",
  "docs/expressions.mdx": "a45472cf8b6fafe58710b6f810cf8116a9213a02039b9209c686f339d28c5fc3",
  "docs/inline-jsx.mdx": "db88cc682b22c78b6e7cdcfba1d16d906e49ffd93a52c8504808d961565c1de2",
  "docs/plain-markdown.md": "8ccebd5b5dd1254b71c67d3b0e58c1e567219d67fd68437347893d30526337ea",
  "docs/static-data.mdx": "ea3f9e1ca502f7714e794dd273e1dae8ccab2fc49fd3809478dd76f3f640b99e",
};
const localSourceHashes = {
  "pt-BR/docs/block-jsx.mdx": "d603785e2ee730cd61c299fffed971882438f20abd59a1776f52432a6844b95c",
  "pt-BR/docs/expressions.mdx": "b3aeadf4eda27ef6f83faf521b7c382271c603601a8eba91578bf8e12cdf33ca",
  "pt-BR/docs/inline-jsx.mdx": "d0fd6e76bd4fe60319b2427ddaac6f13f1a6f49e0c9ca52a66e2f4e7bad50adf",
  "pt-BR/docs/plain-markdown.md": "da48b6282dd5fb8ef174eca1cc6bde469d0f1dc6516445e0cab45180196d8f3c",
  "pt-BR/docs/static-data.mdx": "66841e3dcdc8e1a4926fb34b244cf42da073b5b3215946ad0770b98f71524ebb",
  "fr-FR/docs/block-jsx.mdx": "6e0fa4eeda9f2d8be76e38f6583fba8c7877e4ef50380f2375813ce268af5aa2",
  "fr-FR/docs/expressions.mdx": "9ec3feed4aeae36d06a2fecb049752fdefa962814a7760164222d497f0b73562",
  "fr-FR/docs/inline-jsx.mdx": "9126c18f9bc2059a260e002d9ee1dec3aca7462175afb870c9be20ef7bb5f191",
  "fr-FR/docs/plain-markdown.md": "f302200778242da8d6574216e40a2bb2328493e235c78d5324c923986c5574a6",
  "fr-FR/docs/static-data.mdx": "4c1c9a1ac749596481fbfac4e4bc33d205356f1e880f57410d3406464a0fad23",
};
const outputDigests = {
  "pt-BR/docs/block-jsx.mdx": "0dd866e0845d17b368399c067368c5e9ea5ebcd04e2c76f057851f2dd1bcb407",
  "pt-BR/docs/expressions.mdx": "5b26369e1494cc12d929f10343aa5da90ef6edbfc91b87aa8dcae8c3eb58bc24",
  "pt-BR/docs/inline-jsx.mdx": "5a18c49dad816aaa4927b6895a314868137650453d471236a4f8ee5f99c3f87c",
  "pt-BR/docs/plain-markdown.md": "63d19914e7932d5911b7a2e2db502f63d05ad1ceb52c3ec2ab0e5e183dea1bff",
  "pt-BR/docs/static-data.mdx": "6587cc19c5b1aa37729e6ad8c2cc412ae0b73138b920fba04c7974b14d7e9661",
  "fr-FR/docs/block-jsx.mdx": "0580cc3c2e0aaea0dfb1905ce689a971bf850f56cd8451c2ddbb912800b65271",
  "fr-FR/docs/expressions.mdx": "7fe3552758a30774a699932fa2036ce10811d6c25ece4d4a51d24c2ef1dc707b",
  "fr-FR/docs/inline-jsx.mdx": "094b341575f2189ab1a51bb9bde4e0076aa35cbcd5f9879f5d5eafdbd45d0f2e",
  "fr-FR/docs/plain-markdown.md": "eec245f660e9574679ae1f7dd4956867f4f7b7742e904b45199dbf58a147d22d",
  "fr-FR/docs/static-data.mdx": "1cabe32c0a9ef9764e83b7ed3952ec9d567ab6ef3e4b621651f105695e9415f6",
};
const expectedTotals = { cacheHits: 0, aiTranslated: 10, overrides: 0, skipped: 0, localSkipped: 0, errors: 0 };
const mdxImportCounts = {
  "docs/block-jsx.mdx": 2,
  "docs/expressions.mdx": 1,
  "docs/inline-jsx.mdx": 2,
  "docs/static-data.mdx": 1,
};

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

try {
  await Promise.all([
    rm(path.join(playgroundRoot, "i18n-preview"), { recursive: true, force: true }),
    rm(path.join(playgroundRoot, ".astro", "i18n-staging"), { recursive: true, force: true }),
    rm(path.join(playgroundRoot, "i18n-r2-report.json"), { force: true }),
  ]);
  await runCommand(pnpm, ["build"], { cwd: repositoryRoot, timeoutMs: 300_000 });
  const dryRunResult = await runCommand(pnpm, ["--filter", "polystella-playground-mdx-jsx", "translate:dry-run"], {
    cwd: repositoryRoot,
    env: { ...process.env, LOG_LEVEL: "debug" },
  });
  const dryRunOutput = dryRunResult.stdout + dryRunResult.stderr;
  await runCommand(pnpm, ["--filter", "polystella-playground-mdx-jsx", "translate:local"], { cwd: repositoryRoot });

  const actualDryRunKeys = [...dryRunOutput.matchAll(/would check cache for (i18n\/\S+)/g)].map((match) => match[1]).sort();
  const expectedDryRunKeys = Object.entries(dryRunHashes)
    .flatMap(([source, hash]) => ["pt-BR", "fr-FR"].map((locale) => `i18n/${locale}/${source}#${hash}.md`))
    .sort();
  assertEqual("dry-run R2 keys", actualDryRunKeys, expectedDryRunKeys);

  for (const [relativePath, expectedDigest] of Object.entries(outputDigests)) {
    const preview = await readFile(path.join(playgroundRoot, "i18n-preview", relativePath), "utf8");
    assertMdxImports(relativePath, preview, "../../components/", "preview");
    assertEqual(`${relativePath} preview digest`, sha256(normalizeOutput(preview)), expectedDigest);

    const staged = await readFile(path.join(playgroundRoot, ".astro", "i18n-staging", relativePath), "utf8");
    assertMdxImports(relativePath, staged, "../../../../src/components/", "staged");
    const normalizedStaged = normalizeOutput(staged).replaceAll('from "../../../../src/components/', 'from "../../components/');
    assertEqual(`${relativePath} staged digest`, sha256(normalizedStaged), expectedDigest);
  }

  const report = JSON.parse(await readFile(path.join(playgroundRoot, "i18n-r2-report.json"), "utf8"));
  assertEqual("report totals", report.totals, expectedTotals);
  assertEqual("report PolyStella version", report.build.polystellaVersion, polystellaVersion);
  const reportEntries = [...report.entries].sort((left, right) =>
    `${left.locale}/${left.sourcePath}`.localeCompare(`${right.locale}/${right.sourcePath}`),
  );
  for (const entry of reportEntries) {
    const key = `${entry.locale}/${entry.sourcePath}`;
    assertEqual(`${key} source hash`, entry.sourceHash, localSourceHashes[key]);
    assertEqual(`${key} model`, entry.model, `playground/fake-workers-ai/${entry.locale}`);
  }
  const normalizedReport = structuredClone(report);
  delete normalizedReport.build.startedAt;
  delete normalizedReport.build.durationMs;
  normalizedReport.build.polystellaVersion = "<version>";
  for (const entry of normalizedReport.entries) delete entry.durationMs;
  normalizedReport.entries.sort((left, right) => `${left.locale}/${left.sourcePath}`.localeCompare(`${right.locale}/${right.sourcePath}`));
  assertEqual(
    "normalized report digest",
    sha256(`${JSON.stringify(normalizedReport, null, 2)}\n`),
    "ab8321dd5d768adff6b5df6556a1ae6a288c1cfdbdef6a43691e1255fab88ac0",
  );

  const { computeSourceHash } = await import(pathToFileURL(path.join(repositoryRoot, "packages", "astro", "dist", "index.js")).href);
  assertEqual(
    "source-hash fixture",
    computeSourceHash({
      body: "# Hello\n\nA paragraph.\n",
      frontmatter: { title: "Hello", year: 2025 },
      glossaryHash: "g0",
      modelId: "@cf/meta/llama-3.1-8b-instruct",
    }),
    "df40a08682e9df8e0643f5e95651478da8ff06922ad2f8aaec7d479db70bb7ee",
  );

  const { buildPrompt, EMPTY_GLOSSARY } = await import(
    pathToFileURL(path.join(repositoryRoot, "packages", "core", "dist", "index.js")).href
  );
  const prompt = buildPrompt({
    segments: [
      { id: "fm:title", text: "Hello" },
      { id: "body:0", text: "A paragraph." },
    ],
    glossary: EMPTY_GLOSSARY,
    sourceLocale: "en-US",
    targetLocale: "pt-BR",
  });
  assertEqual("system prompt length", prompt.systemPrompt.length, 562);
  assertEqual("system prompt digest", sha256(prompt.systemPrompt), "85eb85ecc4365b214331beac11ddb345ccb939ec73ff3a8110707839e321d39f");
  assertEqual("user prompt length", prompt.userPrompt.length, 322);
  assertEqual("user prompt digest", sha256(prompt.userPrompt), "975ae31980e7f7a782ec257d7584e0ba689b01f006e86c34c82ba029a1363685");

  const { jsonAdapter, yamlAdapter, tomlAdapter } = await import(
    pathToFileURL(path.join(repositoryRoot, "packages", "adapters", "dist", "index.js")).href
  );
  const adapterCases = [
    [
      jsonAdapter,
      '{"title":"Hello","nested":{"body":"World"}}',
      '{\n  "title": "X:Hello",\n  "nested": {\n    "body": "X:World",\n    "aiTranslated": true\n  }\n}',
    ],
    [yamlAdapter, "title: Hello\nnested:\n  body: World\n", "title: X:Hello\nnested:\n  body: X:World\n  aiTranslated: true\n"],
    [
      tomlAdapter,
      'title = "Hello"\n\n[nested]\nbody = "World"\n',
      'title = "X:Hello"\n\n[nested]\nbody = "X:World"\naiTranslated = true\n',
    ],
  ];
  for (const [adapter, source, expectedOutput] of adapterCases) {
    const parsed = adapter.parse(source);
    const segments = adapter.extractSegments(parsed, source, {
      sourcePath: "content/entry.data",
      translatableKeys: { "content/**": ["title", "nested.body"] },
    });
    assertEqual("structured adapter segments", segments, [
      { id: "title", text: "Hello" },
      { id: "nested.body", text: "World" },
    ]);
    const translations = new Map(segments.map((segment) => [segment.id, `X:${segment.text}`]));
    assertEqual(
      "structured adapter output",
      adapter.applyTranslations(parsed, source, translations, { topLevelAdditions: { aiTranslated: true } }),
      expectedOutput,
    );
  }

  console.log("check:baseline passed: 10 dry-run keys, 10 preview/staged outputs, report, hashes, prompts, and 3 structured adapters");
  console.log(
    "not checked here: real R2 hits/writes/pruning, overrides, noTranslate, and local-cache skips; existing tests cover these paths",
  );
} finally {
  await cleanupCommands();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOutput(value) {
  return value.replace(/^aiTranslatedAt:.*$/mu, "aiTranslatedAt: <timestamp>");
}

function assertMdxImports(relativePath, value, expectedPrefix, artifact) {
  const sourcePath = relativePath.slice(relativePath.indexOf("/") + 1);
  const expectedCount = mdxImportCounts[sourcePath];
  if (expectedCount === undefined) return;
  const imports = [...value.matchAll(/^import .+ from "([^"]+)";$/gmu)].map((match) => match[1]);
  assertEqual(`${relativePath} ${artifact} import count`, imports.length, expectedCount);
  if (!imports.every((specifier) => specifier.startsWith(expectedPrefix))) {
    throw new Error(`${relativePath} ${artifact} imports are ${JSON.stringify(imports)}, expected prefix ${expectedPrefix}`);
  }
}

function assertEqual(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch\nactual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

async function stop(exitCode) {
  await cleanupCommands();
  process.exit(exitCode);
}
