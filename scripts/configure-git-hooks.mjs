import { spawnSync } from "node:child_process";

spawnSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
