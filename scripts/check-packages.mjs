#!/usr/bin/env node
// @ts-check

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { cleanupCommands, runCommand } from "./run-command.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packages = [
  {
    directory: path.join(repositoryRoot, "packages", "astro"),
    name: "@cloudflare/polystella-astro",
    exports: [
      ".",
      "./runtime",
      "./runtime/middleware",
      "./content",
      "./i18n",
      "./catalog",
      "./catalog/middleware",
      "./catalog/astro",
      "./react",
      "./recipes",
      "./recipes/starlight",
      "./client",
    ],
    internalDependencies: [
      "@cloudflare/polystella-core",
      "@cloudflare/polystella-adapters",
      "@cloudflare/polystella-providers",
      "@cloudflare/polystella-cli",
    ],
    allowedTopLevel: [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "client.d.ts",
      "dist",
      "package.json",
      "src",
      "tsconfig.build.json",
      "tsconfig.json",
      "types-internal",
    ],
    requiredFiles: [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "client.d.ts",
      "dist/cli.js",
      "dist/index.d.ts",
      "dist/index.js",
      "src/index.ts",
    ],
    executable: "dist/cli.js",
  },
  {
    directory: path.join(repositoryRoot, "packages", "polystella"),
    name: "@cloudflare/polystella",
    exports: [
      ".",
      "./runtime",
      "./runtime/middleware",
      "./content",
      "./i18n",
      "./catalog",
      "./catalog/middleware",
      "./catalog/astro",
      "./react",
      "./recipes",
      "./recipes/starlight",
      "./client",
    ],
    internalDependencies: ["@cloudflare/polystella-astro"],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "client.d.ts", "dist", "package.json", "src"],
    requiredFiles: [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "client.d.ts",
      "dist/cli.js",
      "dist/index.d.ts",
      "dist/index.js",
      "src/index.ts",
    ],
    executable: "dist/cli.js",
  },
  {
    directory: path.join(repositoryRoot, "packages", "core"),
    name: "@cloudflare/polystella-core",
    exports: [".", "./catalog", "./catalog/translate"],
    internalDependencies: [],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "dist", "package.json", "src"],
    requiredFiles: ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "src/index.ts"],
  },
  {
    directory: path.join(repositoryRoot, "packages", "adapters"),
    name: "@cloudflare/polystella-adapters",
    exports: ["."],
    internalDependencies: ["@cloudflare/polystella-core"],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "dist", "package.json", "src"],
    requiredFiles: ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "src/index.ts"],
  },
  {
    directory: path.join(repositoryRoot, "packages", "providers"),
    name: "@cloudflare/polystella-providers",
    exports: [".", "./workers-ai", "./anthropic"],
    internalDependencies: ["@cloudflare/polystella-core"],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "dist", "package.json", "src"],
    requiredFiles: ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "src/index.ts"],
  },
  {
    directory: path.join(repositoryRoot, "packages", "cli"),
    name: "@cloudflare/polystella-cli",
    exports: [".", "./check-ui", "./config", "./drift", "./glossary", "./run-command", "./sync", "./sync-ui", "./translate-ui"],
    internalDependencies: ["@cloudflare/polystella-core", "@cloudflare/polystella-providers"],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "dist", "package.json", "src"],
    requiredFiles: ["CHANGELOG.md", "LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "src/index.ts"],
  },
  {
    directory: path.join(repositoryRoot, "packages", "emdash"),
    name: "@cloudflare/polystella-emdash",
    exports: [".", "./admin", "./config"],
    internalDependencies: ["@cloudflare/polystella-cli", "@cloudflare/polystella-core", "@cloudflare/polystella-providers"],
    allowedTopLevel: ["CHANGELOG.md", "LICENSE", "README.md", "dist", "package.json", "src"],
    requiredFiles: [
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "dist/admin.d.ts",
      "dist/admin.js",
      "dist/cli.js",
      "dist/config.d.ts",
      "dist/config.js",
      "dist/index.d.ts",
      "dist/index.js",
      "src/admin.tsx",
      "src/index.ts",
    ],
    executable: "dist/cli.js",
  },
];
const lowerPackageEntries = [
  "@cloudflare/polystella-core",
  "@cloudflare/polystella-core/catalog",
  "@cloudflare/polystella-core/catalog/translate",
  "@cloudflare/polystella-adapters",
  "@cloudflare/polystella-providers",
  "@cloudflare/polystella-providers/workers-ai",
  "@cloudflare/polystella-providers/anthropic",
  "@cloudflare/polystella-cli",
  "@cloudflare/polystella-cli/check-ui",
  "@cloudflare/polystella-cli/config",
  "@cloudflare/polystella-cli/drift",
  "@cloudflare/polystella-cli/glossary",
  "@cloudflare/polystella-cli/run-command",
  "@cloudflare/polystella-cli/sync",
  "@cloudflare/polystella-cli/sync-ui",
  "@cloudflare/polystella-cli/translate-ui",
  "@cloudflare/polystella-emdash",
  "@cloudflare/polystella-emdash/admin",
  "@cloudflare/polystella-emdash/config",
];
const nodeSafeAstroEntries = [
  "@cloudflare/polystella",
  "@cloudflare/polystella/catalog",
  "@cloudflare/polystella/catalog/middleware",
  "@cloudflare/polystella/catalog/astro",
  "@cloudflare/polystella/recipes",
  "@cloudflare/polystella/recipes/starlight",
  "@cloudflare/polystella-astro",
  "@cloudflare/polystella-astro/catalog",
  "@cloudflare/polystella-astro/catalog/middleware",
  "@cloudflare/polystella-astro/catalog/astro",
  "@cloudflare/polystella-astro/recipes",
  "@cloudflare/polystella-astro/recipes/starlight",
];

let temporaryRoot;
let cleanupPromise;
let handlingFailure = false;

process.once("SIGINT", () => void fail(undefined, 130));
process.once("SIGTERM", () => void fail(undefined, 143));
process.once("uncaughtException", (error) => void fail(error, 1));
process.once("unhandledRejection", (error) => void fail(error, 1));

await main().catch((error) => fail(error, 1));

async function main() {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "polystella-packages-"));
  const packDirectory = path.join(temporaryRoot, "tarballs");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  const aliasConsumerDirectory = path.join(temporaryRoot, "alias-consumer");
  try {
    const rootManifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
    assertEqual("workspace root private", rootManifest.private, true);
    for (const { name } of packages.filter(({ name }) => name !== "@cloudflare/polystella")) {
      assertEqual(`workspace root dependency ${name}`, rootManifest.devDependencies?.[name], "workspace:*");
    }
    await runCommand(pnpm, ["build"], { cwd: repositoryRoot, timeoutMs: 300_000 });
    await mkdir(packDirectory, { recursive: true });
    await mkdir(consumerDirectory, { recursive: true });

    const packedPackages = new Map();
    for (const packageInfo of packages) {
      const sourceManifest = JSON.parse(await readFile(path.join(packageInfo.directory, "package.json"), "utf8"));
      if (typeof sourceManifest.version !== "string") throw new Error(`${packageInfo.name}: source version is missing`);
      assertSourceManifest(packageInfo, sourceManifest);
      await runCommand(pnpm, ["pack", "--pack-destination", packDirectory], { cwd: packageInfo.directory });
      const tarballPath = path.join(packDirectory, `${packageInfo.name.slice(1).replace("/", "-")}-${sourceManifest.version}.tgz`);
      if (!existsSync(tarballPath)) throw new Error(`pnpm did not create ${tarballPath}`);

      const files = readTarball(await readFile(tarballPath));
      const packedManifestFile = files.get("package/package.json");
      if (packedManifestFile === undefined) throw new Error(`${packageInfo.name}: package.json is missing from tarball`);
      const packedManifest = JSON.parse(packedManifestFile.contents.toString("utf8"));
      assertManifest(packageInfo, packedManifest, files);
      assertTarball(packageInfo, files);
      packedPackages.set(packageInfo.name, { manifest: packedManifest, tarballPath });
    }

    const astroPackage = packedPackages.get("@cloudflare/polystella-astro");
    const compatibilityPackage = packedPackages.get("@cloudflare/polystella");
    if (astroPackage === undefined || compatibilityPackage === undefined) throw new Error("missing fixed-group package");
    const astroVersion = astroPackage.manifest.version;
    assertEqual("Astro and compatibility package versions", compatibilityPackage.manifest.version, astroVersion);
    for (const packageInfo of packages) {
      const packed = packedPackages.get(packageInfo.name);
      if (packed === undefined) throw new Error(`missing packed package ${packageInfo.name}`);
      const actualInternalDependencies = Object.keys(packed.manifest.dependencies ?? {}).filter((name) =>
        name.startsWith("@cloudflare/polystella"),
      );
      assertEqual(
        `${packageInfo.name} internal dependencies`,
        actualInternalDependencies.sort(),
        [...packageInfo.internalDependencies].sort(),
      );
      for (const dependency of packageInfo.internalDependencies) {
        const dependencyPackage = packedPackages.get(dependency);
        if (dependencyPackage === undefined) throw new Error(`missing packed dependency ${dependency}`);
        const prefix = packageInfo.name === "@cloudflare/polystella" ? "" : "^";
        assertEqual(
          `${packageInfo.name} dependency ${dependency}`,
          packed.manifest.dependencies?.[dependency],
          `${prefix}${dependencyPackage.manifest.version}`,
        );
      }
    }

    await writeConsumer(consumerDirectory, packedPackages);
    await cp(consumerDirectory, aliasConsumerDirectory, { recursive: true });
    await writeAliasConsumer(aliasConsumerDirectory, packedPackages);
    await runCommand(pnpm, ["install", "--ignore-scripts"], { cwd: consumerDirectory, timeoutMs: 300_000 });
    await assertTarballInstall(consumerDirectory, packedPackages);

    await runCommand(process.execPath, ["check-imports.mjs"], { cwd: consumerDirectory });
    const cli = await runCommand(
      process.execPath,
      [path.join("node_modules", "@cloudflare", "polystella-astro", "dist", "cli.js"), "--version"],
      { cwd: consumerDirectory },
    );
    assertEqual("canonical CLI version", cli.stdout.trim(), astroVersion);
    const aliasCli = await runCommand(
      process.execPath,
      [path.join("node_modules", "@cloudflare", "polystella", "dist", "cli.js"), "--version"],
      { cwd: consumerDirectory },
    );
    assertEqual("alias CLI version", aliasCli.stdout.trim(), astroVersion);
    const emdashCli = await runCommand(
      process.execPath,
      [path.join("node_modules", "@cloudflare", "polystella-emdash", "dist", "cli.js"), "--help"],
      { cwd: consumerDirectory },
    );
    if (!emdashCli.stdout.includes("check-ui")) throw new Error("EmDash CLI help omits catalog commands");
    await runCommand(pnpm, ["exec", "astro", "build"], {
      cwd: consumerDirectory,
      env: { ...process.env, CI: "true" },
      timeoutMs: 180_000,
    });
    await runCommand(pnpm, ["exec", "tsc", "--noEmit"], { cwd: consumerDirectory, timeoutMs: 180_000 });

    await runCommand(pnpm, ["install", "--ignore-scripts"], { cwd: aliasConsumerDirectory, timeoutMs: 300_000 });
    await runCommand(process.execPath, ["check-imports.mjs"], { cwd: aliasConsumerDirectory });
    const aliasOnlyCli = await runCommand(
      process.execPath,
      [path.join("node_modules", "@cloudflare", "polystella", "dist", "cli.js"), "--version"],
      { cwd: aliasConsumerDirectory },
    );
    assertEqual("alias-only CLI version", aliasOnlyCli.stdout.trim(), astroVersion);
    await runCommand(pnpm, ["exec", "astro", "build"], {
      cwd: aliasConsumerDirectory,
      env: { ...process.env, CI: "true" },
      timeoutMs: 180_000,
    });
    await runCommand(pnpm, ["exec", "tsc", "--noEmit"], { cwd: aliasConsumerDirectory, timeoutMs: 180_000 });

    console.log(
      `check:packages passed: ${packages.length} tarballs, Astro ${astroVersion}, ${lowerPackageEntries.length + nodeSafeAstroEntries.length} runtime imports, full and alias-only Astro builds/typechecks, and all CLIs`,
    );
  } finally {
    await cleanup();
  }
}

async function writeAliasConsumer(consumerDirectory, packedPackages) {
  const aliasPackage = packedPackages.get("@cloudflare/polystella");
  if (aliasPackage === undefined) throw new Error("missing packed alias package");
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@cloudflare/polystella": `file:${aliasPackage.tarballPath}`,
          astro: "7.3.1",
          react: "^19.0.0",
        },
        devDependencies: { "@types/react": "^19.0.0", typescript: "^6.0.3" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "pnpm-workspace.yaml"),
    `overrides:\n${packages
      .filter(({ name }) => name !== "@cloudflare/polystella")
      .map(({ name }) => {
        const packed = packedPackages.get(name);
        if (packed === undefined) throw new Error(`missing packed package ${name}`);
        return `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${packed.tarballPath}`)}`;
      })
      .join("\n")}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "check-imports.mjs"),
    `${nodeSafeAstroEntries
      .filter((specifier) => specifier === "@cloudflare/polystella" || specifier.startsWith("@cloudflare/polystella/"))
      .map(
        (specifier) =>
          `if (Object.keys(await import(${JSON.stringify(specifier)})).length === 0) throw new Error(${JSON.stringify(`${specifier} has no exports`)});`,
      )
      .join("\n")}\n`,
  );
  for (const relativePath of ["astro.config.mjs", "src/env.d.ts", "src/content.config.ts", "src/pages/index.astro"]) {
    const file = path.join(consumerDirectory, relativePath);
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("@cloudflare/polystella-astro", "@cloudflare/polystella"));
  }
  await writeFile(
    path.join(consumerDirectory, "src", "entrypoints.ts"),
    `import polystella from "@cloudflare/polystella";\nimport catalogAstro from "@cloudflare/polystella/catalog/astro";\nimport { polystellaCollections } from "@cloudflare/polystella/content";\nimport { getTranslations } from "@cloudflare/polystella/i18n";\nimport { useTranslations } from "@cloudflare/polystella/react";\nimport { localizedHref } from "@cloudflare/polystella/runtime";\nimport { polystellaMiddleware } from "@cloudflare/polystella/runtime/middleware";\n\nexport const typedEntrypoints = [polystella, catalogAstro, polystellaCollections, getTranslations, useTranslations, localizedHref, polystellaMiddleware];\n`,
  );
  await rm(path.join(consumerDirectory, "src", "catalog-entrypoints.ts"));
}

async function writeConsumer(consumerDirectory, packedPackages) {
  const tarballDependencies = Object.fromEntries(
    packages.map(({ name }) => {
      const packed = packedPackages.get(name);
      if (packed === undefined) throw new Error(`missing packed package ${name}`);
      return [name, `file:${packed.tarballPath}`];
    }),
  );
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { ...tarballDependencies, astro: "7.3.1", emdash: "0.36.0", react: "^19.0.0" },
        devDependencies: { "@types/react": "^19.0.0", typescript: "^6.0.3" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "pnpm-workspace.yaml"),
    `overrides:\n${packages
      .filter(({ name }) => name !== "@cloudflare/polystella")
      .map(({ name }) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarballDependencies[name])}`)
      .join("\n")}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "check-imports.mjs"),
    `${[...lowerPackageEntries, ...nodeSafeAstroEntries]
      .map(
        (specifier) =>
          `if (Object.keys(await import(${JSON.stringify(specifier)})).length === 0) throw new Error(${JSON.stringify(`${specifier} has no exports`)});`,
      )
      .join("\n")}\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "astro.config.mjs"),
    `import polystella from "@cloudflare/polystella-astro";\nimport catalogAstro from "@cloudflare/polystella-astro/catalog/astro";\nimport { defineConfig } from "astro/config";\n\nexport default defineConfig({\n  integrations: [catalogAstro({ driftCheck: false }), polystella({ sourceDir: "./src/content", include: ["**/*.md"], dryRun: true })],\n  i18n: { defaultLocale: "en-US", locales: ["en-US", "pt-BR"] },\n});\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: "astro/tsconfigs/strict",
        include: [".astro/types.d.ts", "src/**/*.ts", "src/**/*.d.ts"],
        compilerOptions: { noEmit: true },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.join(consumerDirectory, "src", "content", "docs"), { recursive: true });
  await mkdir(path.join(consumerDirectory, "src", "pages"), { recursive: true });
  await writeFile(
    path.join(consumerDirectory, "src", "env.d.ts"),
    `/// <reference types="astro/client" />\n/// <reference types="@cloudflare/polystella-astro/client" />\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "src", "content.config.ts"),
    `import { polystellaCollections } from "@cloudflare/polystella-astro/content";\nimport { defineCollection, z } from "astro:content";\nimport { glob } from "astro/loaders";\n\nconst docs = defineCollection({ loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }), schema: z.object({ title: z.string() }) });\nexport const collections = polystellaCollections({ source: { docs } });\n`,
  );
  await writeFile(path.join(consumerDirectory, "src", "content", "docs", "hello.md"), `---\ntitle: Hello\n---\n\n# Hello\n`);
  await writeFile(
    path.join(consumerDirectory, "src", "entrypoints.ts"),
    `import { jsonAdapter } from "@cloudflare/polystella-adapters";\nimport { buildPrompt, EMPTY_GLOSSARY, type Segment, type Translator } from "@cloudflare/polystella-core";\nimport { polystellaEmdash } from "@cloudflare/polystella-emdash";\nimport { createWorkersAIHttpTranslator } from "@cloudflare/polystella-providers";\nimport { createAnthropicTranslator, type AnthropicTranslatorOptions } from "@cloudflare/polystella-providers/anthropic";\nimport { createWorkersAIBindingTranslator, type WorkersAIInput } from "@cloudflare/polystella-providers/workers-ai";\nimport { polystellaCollections } from "@cloudflare/polystella-astro/content";\nimport { getTranslations } from "@cloudflare/polystella-astro/i18n";\nimport { useTranslations } from "@cloudflare/polystella-astro/react";\nimport { localizedHref } from "@cloudflare/polystella-astro/runtime";\nimport { polystellaMiddleware } from "@cloudflare/polystella-astro/runtime/middleware";\nimport { defaultLocale } from "polystella:runtime-config";\n\nconst segment: Segment = { id: "body:0", text: "Hello" };\nconst prompt = buildPrompt({ segments: [segment], glossary: EMPTY_GLOSSARY, sourceLocale: "en-US", targetLocale: "pt-BR" });\nconst input: WorkersAIInput = { messages: [{ role: "user", content: prompt.userPrompt }], max_tokens: 64 };\nconst bindingTranslator: Translator = createWorkersAIBindingTranslator({ modelId: "test", maxTokens: 64, run: async () => ({ response: "Ola" }) });\nconst httpTranslator: Translator = createWorkersAIHttpTranslator({ accountId: "test", apiToken: "test", modelId: "test", maxTokens: 64 });\nconst anthropicOptions: AnthropicTranslatorOptions = { apiKey: "test", modelId: "test", maxTokens: 64 };\nconst anthropicTranslator: Translator = createAnthropicTranslator(anthropicOptions);\nconst emdashPlugin = polystellaEmdash({ provider: { kind: "workers-ai-binding", binding: "AI" }, collections: {}, catalogs: { defaultLocale: "en-US", locales: { "en-US": { dictionary: { greeting: "Hello" }, filePath: "src/i18n/en-US.json" } } }, models: { allowed: ["test"], defaults: { default: "test" } } });\n\nexport const typedEntrypoints = [jsonAdapter, prompt, input, bindingTranslator, httpTranslator, anthropicTranslator, emdashPlugin, polystellaCollections, getTranslations, useTranslations, localizedHref, polystellaMiddleware, defaultLocale];\n`,
  );
  await writeFile(
    path.join(consumerDirectory, "src", "catalog-entrypoints.ts"),
    `import { buildTranslateFn, type CatalogDictionary } from "@cloudflare/polystella-core/catalog";
import { extractTokens } from "@cloudflare/polystella-core/catalog/translate";

const dictionary: CatalogDictionary = { greeting: "Hello, {{name}}" };
export const translated = buildTranslateFn(dictionary)("greeting", { name: "world" });
export const tokens = extractTokens(dictionary.greeting ?? "");
`,
  );
  await writeFile(
    path.join(consumerDirectory, "src", "pages", "index.astro"),
    `---\nimport { getTranslations } from "@cloudflare/polystella-astro/i18n";\nimport { useTranslations } from "@cloudflare/polystella-astro/react";\nimport { localizedHref } from "@cloudflare/polystella-astro/runtime";\nimport { polystellaMiddleware } from "@cloudflare/polystella-astro/runtime/middleware";\n\nconst surfaces = [getTranslations, useTranslations, localizedHref, polystellaMiddleware];\n---\n<html><body><a href={localizedHref("/", "pt-BR")} data-surfaces={surfaces.length}>Installed PolyStella</a></body></html>\n`,
  );
}

async function assertTarballInstall(consumerDirectory, packedPackages) {
  const lockfile = await readFile(path.join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
  const consumerLocation = await realpath(consumerDirectory);
  for (const packageInfo of packages) {
    const packed = packedPackages.get(packageInfo.name);
    if (packed === undefined) throw new Error(`missing packed package ${packageInfo.name}`);
    const tarballName = path.basename(packed.tarballPath);
    if (!new RegExp(`file:[^\\n]*${escapeRegExp(tarballName)}`).test(lockfile))
      throw new Error(`${packageInfo.name}: lockfile does not reference ${tarballName}`);

    const installedManifestPath = path.join(consumerDirectory, "node_modules", ...packageInfo.name.split("/"), "package.json");
    const installedLocation = await realpath(path.dirname(installedManifestPath));
    const relativeLocation = path.relative(consumerLocation, installedLocation);
    if (relativeLocation.startsWith("..") || path.isAbsolute(relativeLocation)) {
      throw new Error(`${packageInfo.name}: installed outside temporary consumer at ${installedLocation}`);
    }
    const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
    assertEqual(`${packageInfo.name} installed manifest`, installedManifest, packed.manifest);
  }
}

function assertManifest(packageInfo, manifest, files) {
  assertEqual(`${packageInfo.name} packed name`, manifest.name, packageInfo.name);
  assertEqual(`${packageInfo.name} exports`, Object.keys(manifest.exports ?? {}).sort(), [...packageInfo.exports].sort());
  if (JSON.stringify(manifest).includes("workspace:")) throw new Error(`${packageInfo.name}: packed manifest contains a workspace: range`);
  for (const target of exportTargets(manifest.exports)) {
    const file = `package/${target.replace(/^\.\//, "")}`;
    if (!files.has(file)) throw new Error(`${packageInfo.name}: export target ${target} is missing from tarball`);
  }
}

function assertSourceManifest(packageInfo, manifest) {
  const actualInternalDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@cloudflare/polystella"));
  assertEqual(
    `${packageInfo.name} source internal dependencies`,
    actualInternalDependencies.sort(),
    [...packageInfo.internalDependencies].sort(),
  );
  for (const dependency of packageInfo.internalDependencies) {
    const workspaceRange = packageInfo.name === "@cloudflare/polystella" ? "workspace:*" : "workspace:^";
    assertEqual(`${packageInfo.name} source dependency ${dependency}`, manifest.dependencies?.[dependency], workspaceRange);
  }
}

function assertTarball(packageInfo, files) {
  const allowedTopLevel = new Set(packageInfo.allowedTopLevel);
  for (const [file, entry] of files) {
    if (!file.startsWith("package/")) throw new Error(`${packageInfo.name}: unexpected tar entry ${file}`);
    const relativePath = file.slice("package/".length);
    const pathSegments = relativePath.split("/");
    const normalizedPathSegments = pathSegments.map((segment) => segment.toLowerCase());
    if (!allowedTopLevel.has(pathSegments[0])) throw new Error(`${packageInfo.name}: ${relativePath} is outside the tar allowlist`);
    if (
      /(?:^|\/)[^/]+\.(?:test|spec)(?:-[^/]+)?\.[^/]+$/i.test(relativePath) ||
      /(?:^|\/)[^/]+\.snap$/i.test(relativePath) ||
      /(?:^|\/)[^/]+\.(?:key|p12|pem|pfx)$/i.test(relativePath) ||
      /(?:^|\/)(?:credentials?|private[-_.]?key|secrets?)\.(?:json|toml|txt|ya?ml)$/i.test(relativePath) ||
      /(?:^|\/)id_(?:dsa|ecdsa|ed25519|rsa)$/i.test(relativePath) ||
      /-----BEGIN (?:PRIVATE KEY|(?:DSA|EC|ENCRYPTED|OPENSSH|RSA) PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(
        entry.contents.toString("utf8"),
      ) ||
      normalizedPathSegments.some(
        (segment) =>
          segment === "test" ||
          segment === "tests" ||
          segment === "__tests__" ||
          segment === "__fixtures__" ||
          segment === "__snapshots__" ||
          segment === "node_modules" ||
          segment === ".wrangler" ||
          segment.startsWith(".dev.vars") ||
          segment === ".env" ||
          segment.startsWith(".env."),
      )
    ) {
      throw new Error(`${packageInfo.name}: forbidden tar entry ${relativePath}`);
    }
  }
  for (const requiredFile of ["package.json", ...packageInfo.requiredFiles]) {
    if (!files.has(`package/${requiredFile}`)) throw new Error(`${packageInfo.name}: required file ${requiredFile} is missing`);
  }
  assertSourceMaps(packageInfo, files);
  if (packageInfo.executable !== undefined) {
    const executable = files.get(`package/${packageInfo.executable}`);
    if (executable === undefined) throw new Error(`${packageInfo.name}: executable ${packageInfo.executable} is missing`);
    if ((executable.mode & 0o111) === 0) throw new Error(`${packageInfo.name}: ${packageInfo.executable} is not executable`);
    if (!executable.contents.toString("utf8").startsWith("#!/usr/bin/env node\n")) {
      throw new Error(`${packageInfo.name}: ${packageInfo.executable} has no Node shebang`);
    }
  }
}

function assertSourceMaps(packageInfo, files) {
  const emittedFiles = [...files.keys()].filter(
    (file) => file.startsWith("package/dist/") && (file.endsWith(".js") || file.endsWith(".d.ts")),
  );
  for (const emittedFile of emittedFiles) {
    const mapFile = `${emittedFile}.map`;
    const mapEntry = files.get(mapFile);
    if (mapEntry === undefined) throw new Error(`${packageInfo.name}: ${mapFile.slice(8)} is missing`);

    const sourceMap = JSON.parse(mapEntry.contents.toString("utf8"));
    if (
      sourceMap.version !== 3 ||
      !Array.isArray(sourceMap.sources) ||
      sourceMap.sources.length === 0 ||
      !sourceMap.sources.every((source) => typeof source === "string") ||
      (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== "string")
    ) {
      throw new Error(`${packageInfo.name}: ${mapFile.slice(8)} has invalid sources`);
    }
    const mapDirectory = path.posix.dirname(mapFile.slice("package/".length));
    const sourceRoot = typeof sourceMap.sourceRoot === "string" ? sourceMap.sourceRoot : "";
    for (const source of sourceMap.sources) {
      const resolvedSource = path.posix.normalize(path.posix.join(mapDirectory, sourceRoot, source));
      if (resolvedSource.startsWith("../") || !files.has(`package/${resolvedSource}`)) {
        throw new Error(`${packageInfo.name}: ${mapFile.slice(8)} references missing source ${resolvedSource}`);
      }
    }
  }
}

function exportTargets(value) {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function readTarball(compressed) {
  const archive = gunzipSync(compressed);
  const files = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const mode = Number.parseInt(readTarString(header, 100, 8).trim() || "0", 8);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(mode)) throw new Error(`invalid tar mode for ${name}`);
    if (!Number.isFinite(size)) throw new Error(`invalid tar size for ${name}`);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const start = offset + 512;
    files.set(fullName, { contents: archive.subarray(start, start + size), mode });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarString(buffer, offset, length) {
  const end = buffer.indexOf(0, offset);
  return buffer.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function assertEqual(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch\nactual:   ${JSON.stringify(actual)}\nexpected: ${JSON.stringify(expected)}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    await cleanupCommands();
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

async function fail(error, exitCode) {
  if (handlingFailure) return;
  handlingFailure = true;
  if (error !== undefined) console.error(error);
  await cleanup();
  process.exitCode = exitCode;
}
