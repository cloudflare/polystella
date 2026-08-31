#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliUrl = new URL("./cli.js", import.meta.resolve("@cloudflare/polystella-astro"));
const result = spawnSync(process.execPath, [fileURLToPath(cliUrl), ...process.argv.slice(2)], { stdio: "inherit" });

if (result.error !== undefined) throw result.error;
if (result.signal !== null) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
