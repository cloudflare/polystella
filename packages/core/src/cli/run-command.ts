import { CHECK_UI_USAGE, parseCheckUiArgs, runCheckUi } from "./check-ui.js";
import { SYNC_UI_USAGE, parseSyncUiArgs, runSyncUi } from "./sync-ui.js";
import { TRANSLATE_UI_USAGE, parseTranslateUiArgs, runTranslateUi } from "./translate-ui.js";

export type CatalogCommand = "check-ui" | "sync-ui" | "translate-ui";

export interface CatalogCommandDependencies {
  cwd: string;
  log(message: string): void;
  warn(message: string): void;
  err(message: string): void;
  signal?: AbortSignal | undefined;
}

export const CATALOG_CLI_USAGE = `polystella <command>

Catalog commands:
  check-ui      Check locale catalogs for drift.
  sync-ui       Reconcile locale catalog keys.
  translate-ui  Sync and translate empty catalog values.

Run polystella <command> --help for command flags.`;

export function isCatalogCommand(value: string | undefined): value is CatalogCommand {
  return value === "check-ui" || value === "sync-ui" || value === "translate-ui";
}

export async function runCatalogCommand(
  command: CatalogCommand,
  argv: ReadonlyArray<string>,
  dependencies: CatalogCommandDependencies,
): Promise<number> {
  let execute: () => Promise<number>;
  try {
    if (command === "check-ui") {
      const args = parseCheckUiArgs(argv);
      execute = () => runCheckUi(args, dependencies);
    } else if (command === "sync-ui") {
      const args = parseSyncUiArgs(argv);
      execute = () => runSyncUi(args, dependencies);
    } else {
      const args = parseTranslateUiArgs(argv);
      execute = () => runTranslateUi(args, dependencies);
    }
  } catch (error) {
    dependencies.err(`[polystella] ${(error as Error).message}\n`);
    dependencies.err(command === "check-ui" ? CHECK_UI_USAGE : command === "sync-ui" ? SYNC_UI_USAGE : TRANSLATE_UI_USAGE);
    return 1;
  }
  return execute();
}
