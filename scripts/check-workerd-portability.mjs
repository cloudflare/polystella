import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrangler = join(root, "docs", "node_modules", "wrangler", "bin", "wrangler.js");
const config = join(root, "fixtures", "workerd", "wrangler.jsonc");
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const children = new Set();
let temporaryDirectory;
let cleanupPromise;
let handlingFailure = false;

process.once("SIGINT", () => void fail(undefined, 130));
process.once("SIGTERM", () => void fail(undefined, 143));
process.once("uncaughtException", (error) => void fail(error, 1));
process.once("unhandledRejection", (error) => void fail(error, 1));

await main().catch((error) => fail(error, 1));

async function main() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "polystella-workerd-"));
  try {
    const bundleDirectory = join(temporaryDirectory, "bundle");
    const dryRun = await runWrangler(["deploy", "--dry-run", "--config", config, "--outdir", bundleDirectory], 30_000);
    process.stdout.write(dryRun);

    const bundleFiles = (await listFiles(bundleDirectory)).filter((file) => /\.[cm]?js$/.test(file));
    assert(bundleFiles.length > 0, "Wrangler dry-run produced no JavaScript bundle");
    const bundle = (await Promise.all(bundleFiles.map((file) => readFile(file, "utf8")))).join("\n");
    inspectBundle(bundle);
    console.log(`Bundle inspection passed (${bundleFiles.length} JavaScript file${bundleFiles.length === 1 ? "" : "s"}).`);

    const port = await getFreePort();
    const server = spawnWrangler([
      "dev",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(temporaryDirectory, "state"),
    ]);
    try {
      const response = await waitForWorker(server, `http://127.0.0.1:${port}/`);
      assert.deepEqual(await response.json(), { prompt: true, title: "Ola", translation: "Ola" });
      console.log("Wrangler no-compat runtime passed.");
    } finally {
      await terminate(server);
    }
  } finally {
    await cleanup();
  }
}

function inspectBundle(bundle) {
  const moduleReference = /\b(?:from\s+|import\s*(?:\(\s*)?|(?:__)?require\s*\(\s*)["']([^"']+)["']/g;
  for (const [, specifier] of bundle.matchAll(moduleReference)) {
    assert(!isNodeBuiltin(specifier), `Node builtin ${specifier} found in Wrangler bundle`);
    assert(
      !/^(?:@astrojs\/|astro(?:\/|$)|react(?:-dom)?(?:\/|$)|satteri(?:\/|$))/.test(specifier),
      `${specifier} found in Wrangler bundle`,
    );
  }
  assert.doesNotMatch(bundle, /node_modules\/(?:@astrojs|astro|react|react-dom|satteri)\//, "Astro/React/Satteri found in Wrangler bundle");
  assert.doesNotMatch(bundle, /["'][^"'\n]+\.node["']/, "native module found in Wrangler bundle");
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "");
  return specifier.startsWith("node:") || nodeBuiltins.has(normalized) || nodeBuiltins.has(normalized.split("/")[0]);
}

function spawnWrangler(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.spawnError = undefined;
  child.closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.once("error", (error) => (child.spawnError = error));
  child.stdout.on("data", (chunk) => (child.output += chunk));
  child.stderr.on("data", (chunk) => (child.output += chunk));
  children.add(child);
  void child.closed.then(() => children.delete(child));
  return child;
}

async function runWrangler(args, timeoutMs) {
  const child = spawnWrangler(args);
  const result = await within(child.closed, timeoutMs);
  if (result === undefined) {
    await terminate(child);
    throw new Error(`Wrangler timed out after ${timeoutMs}ms:\n${child.output}`);
  }
  if (child.spawnError) throw child.spawnError;
  if (result.code !== 0) throw new Error(`Wrangler exited with ${result.code ?? result.signal}:\n${child.output}`);
  return child.output;
}

async function waitForWorker(child, url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      await within(child.closed, 1_000);
      throw new Error(`Wrangler dev exited before startup:\n${child.output}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
    } catch {
      // Wrangler is still starting.
    }
    await delay(100);
  }
  throw new Error(`Wrangler dev did not start within 20 seconds:\n${child.output}`);
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await within(child.closed, 1_000);
    return;
  }
  await killTree(child, false);
  if ((await within(child.closed, 5_000)) !== undefined) return;
  await killTree(child, true);
  if ((await within(child.closed, 5_000)) !== undefined) return;
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  throw new Error(`Unable to terminate Wrangler process tree ${child.pid}`);
}

async function killTree(child, force) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], { stdio: "ignore" });
    const closed = new Promise((resolve) => {
      taskkill.once("error", resolve);
      taskkill.once("close", resolve);
    });
    if ((await within(closed, 3_000)) === undefined) taskkill.kill();
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

async function cleanup() {
  cleanupPromise ??= (async () => {
    await Promise.allSettled([...children].map((child) => terminate(child)));
    if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { recursive: true, force: true });
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

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await listFiles(path) : [path]));
  }
  return files;
}

async function within(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs, undefined);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds, undefined));
}
