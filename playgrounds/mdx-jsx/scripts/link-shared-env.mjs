#!/usr/bin/env node
// @ts-check
// Links this checkout's .env to the primary checkout's, so one file serves every worktree.
// Usage: node scripts/link-shared-env.mjs (the dev scripts run it for you). It never replaces a file that exists.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const playgroundRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * @param {string} [root] The playground directory of this checkout.
 * @returns {"linked" | "already-linked" | "own-file" | "is-primary" | "no-shared-file" | "not-a-worktree" | "failed"}
 */
export function linkSharedEnv(root = playgroundRoot) {
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "not-a-worktree";
  }
  if (path.basename(commonDir) !== ".git") return "not-a-worktree";

  const sharedDirectory = path.join(path.dirname(commonDir), "playgrounds", "mdx-jsx");
  const shared = path.join(sharedDirectory, ".env");
  if (existsSync(sharedDirectory) && realpathSync(sharedDirectory) === realpathSync(root)) return "is-primary";

  const own = path.join(root, ".env");
  let ownStat;
  try {
    ownStat = lstatSync(own);
  } catch {
    ownStat = undefined;
  }
  if (ownStat !== undefined) {
    const linksToShared = ownStat.isSymbolicLink() && path.resolve(path.dirname(own), readlinkSync(own)) === shared;
    return linksToShared ? "already-linked" : "own-file";
  }
  if (!existsSync(shared)) return "no-shared-file";
  try {
    symlinkSync(shared, own);
  } catch (error) {
    // Another dev script may have just linked it. Any other error (no symlink rights) leaves .env alone.
    return error instanceof Error && "code" in error && error.code === "EEXIST" ? linkSharedEnv(root) : "failed";
  }
  return "linked";
}

function runAsScript() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (runAsScript()) {
  const messages = {
    linked: "linked .env to the primary checkout's playgrounds/mdx-jsx/.env",
    "already-linked": ".env already links to the primary checkout's file",
    "own-file": ".env already exists here and was left alone",
    "is-primary": "this is the primary checkout; its .env is the shared one",
    "no-shared-file": "the primary checkout has no playgrounds/mdx-jsx/.env yet; create it there, then run this again",
    "not-a-worktree": "this is not a git checkout with a primary checkout to link to",
    failed: "could not create the link (symlinks may not be allowed here); copy the file by hand instead",
  };
  console.log(messages[linkSharedEnv()]);
}
