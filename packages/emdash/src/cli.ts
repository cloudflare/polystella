#!/usr/bin/env node
import { CATALOG_CLI_USAGE, isCatalogCommand, runCatalogCommand } from "@cloudflare/polystella-cli/run-command";

const [command, ...rest] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.log(CATALOG_CLI_USAGE);
  process.exit(0);
}

if (!isCatalogCommand(command)) {
  console.error(`[polystella] unknown catalog command: ${command}\n`);
  console.error(CATALOG_CLI_USAGE);
  process.exit(1);
}

runCatalogCommand(command, rest, {
  cwd: process.cwd(),
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  err: (message) => console.error(message),
}).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error("[polystella] unexpected error:", error);
    process.exit(2);
  },
);
