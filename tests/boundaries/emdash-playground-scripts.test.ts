import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPTS = join(process.cwd(), "playgrounds", "emdash", "scripts");
const CHECK_MODELS = join(SCRIPTS, "check-models.mjs");

type LinkResult = "linked" | "already-linked" | "own-file" | "is-primary" | "no-shared-file" | "not-a-worktree" | "failed";
interface CatalogueEntry {
  name?: string;
  deprecated?: boolean;
  task?: { name: string };
  properties?: { property_id: string; value: unknown }[];
  schema?: { input?: unknown; output?: unknown };
}

const { linkSharedEnv } = (await import(pathToFileURL(join(SCRIPTS, "link-shared-env.mjs")).href)) as {
  linkSharedEnv: (root?: string) => LinkResult;
};
const { checkModel } = (await import(pathToFileURL(CHECK_MODELS).href)) as {
  checkModel: (id: string, doc: CatalogueEntry | null, today?: Date) => { problems: string[]; warnings: string[] };
};

describe("link-shared-env", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

  let temp: string;
  let primary: string;
  let worktree: string;
  let primaryEnv: string;
  let worktreeRoot: string;
  let primaryRoot: string;

  beforeAll(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), "polystella-link-env-")));
    primary = join(temp, "primary");
    worktree = join(temp, "wt");
    primaryRoot = join(primary, "playgrounds", "emdash");
    worktreeRoot = join(worktree, "playgrounds", "emdash");
    primaryEnv = join(primaryRoot, ".env");
    mkdirSync(primaryRoot, { recursive: true });
    git(primary, "init", "-q");
    writeFileSync(join(primary, ".gitignore"), ".env\n");
    writeFileSync(join(primaryRoot, "placeholder.txt"), "x\n");
    git(primary, "add", ".");
    git(primary, "commit", "-q", "--no-gpg-sign", "-m", "init");
    git(primary, "worktree", "add", "-q", worktree);
    // Make sure the primary has no .env yet: the first case below creates it.
    expect(existsSync(primaryEnv)).toBe(false);
  });

  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const own = () => join(worktreeRoot, ".env");

  it("no-shared-file: the primary has no .env, and nothing is created in the worktree", () => {
    expect(linkSharedEnv(worktreeRoot)).toBe("no-shared-file");
    expect(existsSync(own())).toBe(false);
    expect(() => lstatSync(own())).toThrow();
  });

  it("linked, then already-linked: the symlink resolves to the primary file", () => {
    writeFileSync(primaryEnv, "SECRET=primary\n");
    expect(linkSharedEnv(worktreeRoot)).toBe("linked");
    expect(lstatSync(own()).isSymbolicLink()).toBe(true);
    expect(realpathSync(own())).toBe(realpathSync(primaryEnv));
    expect(readFileSync(own(), "utf8")).toBe("SECRET=primary\n");
    expect(linkSharedEnv(worktreeRoot)).toBe("already-linked");
  });

  it("is-primary: the primary checkout itself", () => {
    expect(linkSharedEnv(primaryRoot)).toBe("is-primary");
    expect(lstatSync(primaryEnv).isSymbolicLink()).toBe(false);
  });

  describe("never replaces an existing .env", () => {
    const reset = () => rmSync(own(), { force: true });

    it("a regular file stays byte-for-byte", () => {
      reset();
      writeFileSync(own(), "MINE=1\n\u00e9");
      const before = readFileSync(own());
      expect(linkSharedEnv(worktreeRoot)).toBe("own-file");
      expect(readFileSync(own()).equals(before)).toBe(true);
      expect(lstatSync(own()).isSymbolicLink()).toBe(false);
    });

    it("a symlink to somewhere else keeps pointing there", () => {
      reset();
      const elsewhere = join(temp, "elsewhere.env");
      writeFileSync(elsewhere, "ELSE=1\n");
      symlinkSync(elsewhere, own());
      expect(linkSharedEnv(worktreeRoot)).toBe("own-file");
      expect(readlinkSync(own())).toBe(elsewhere);
      expect(readFileSync(elsewhere, "utf8")).toBe("ELSE=1\n");
    });

    it("a dangling symlink to somewhere else is left untouched", () => {
      reset();
      const missing = join(temp, "missing.env");
      symlinkSync(missing, own());
      expect(linkSharedEnv(worktreeRoot)).toBe("own-file");
      expect(readlinkSync(own())).toBe(missing);
      expect(existsSync(missing)).toBe(false);
    });
  });

  it("not-a-worktree: a directory outside any git repo", () => {
    const outside = join(temp, "outside");
    mkdirSync(outside);
    // Only meaningful when the temp dir is not itself inside a repository.
    expect(() => git(outside, "rev-parse", "--git-dir")).toThrow();
    expect(linkSharedEnv(outside)).toBe("not-a-worktree");
    expect(existsSync(join(outside, ".env"))).toBe(false);
  });
});

describe("check-models: checkModel", () => {
  const today = new Date("2026-11-26T00:00:00Z");
  const input = {
    anyOf: [
      { oneOf: [{ properties: { prompt: {} } }, { properties: { messages: {}, max_tokens: {} } }] },
      { properties: { requests: {} } },
    ],
  };
  const output = { properties: { response: {} } };
  const good = (overrides: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
    name: "@cf/a/m",
    deprecated: false,
    task: { name: "Text Generation" },
    properties: [],
    schema: { input, output },
    ...overrides,
  });
  const date = (daysFromToday: number) => new Date(today.getTime() + daysFromToday * 86_400_000).toISOString().slice(0, 10);
  const planned = (value: string) => ({ properties: [{ property_id: "planned_deprecation_date", value }] });

  it("accepts a healthy model", () => {
    expect(checkModel("@cf/a/m", good(), today)).toEqual({ problems: [], warnings: [] });
  });

  it("a missing entry is not in the catalogue", () => {
    expect(checkModel("@cf/a/m", null, today)).toEqual({ problems: ["not in the catalogue"], warnings: [] });
  });

  it("a name mismatch is a problem", () => {
    const { problems } = checkModel("@cf/a/m", good({ name: "@cf/a/other" }), today);
    expect(problems).toEqual(["the catalogue lists it as @cf/a/other"]);
  });

  it("a deprecated model is a problem", () => {
    expect(checkModel("@cf/a/m", good({ deprecated: true }), today).problems).toEqual(["marked deprecated"]);
  });

  it("planned deprecation: past or today is a problem, within 60 days a warning, later nothing", () => {
    expect(checkModel("@cf/a/m", good(planned(date(-5))), today).problems[0]).toContain("deprecation was planned for");
    expect(checkModel("@cf/a/m", good(planned(date(0))), today).problems).toHaveLength(1);

    const soon = checkModel("@cf/a/m", good(planned(date(60))), today);
    expect(soon.problems).toEqual([]);
    expect(soon.warnings).toEqual([`deprecation planned for ${date(60)}, in 60 days`]);

    expect(checkModel("@cf/a/m", good(planned(date(61))), today)).toEqual({ problems: [], warnings: [] });
  });

  it("a model that is not text generation is a problem", () => {
    expect(checkModel("@cf/a/m", good({ task: { name: "Text Embeddings" } }), today).problems).toEqual([
      "task is Text Embeddings, not Text Generation",
    ]);
  });

  it("no schema is a problem", () => {
    const { problems } = checkModel("@cf/a/m", good({ schema: undefined }), today);
    expect(problems).toEqual(["no published schema (it may need an access request)"]);
  });

  it("messages without max_tokens is a problem", () => {
    const schema = { input: { oneOf: [{ properties: { messages: {} } }, { properties: { prompt: {}, max_tokens: {} } }] }, output };
    expect(checkModel("@cf/a/m", good({ schema }), today).problems).toEqual(["no documented input with both messages and max_tokens"]);
  });

  it("an undocumented output is only a warning", () => {
    expect(checkModel("@cf/a/m", good({ schema: { input } }), today)).toEqual({ problems: [], warnings: ["reply shape is undocumented"] });
  });

  it("an unreadable planned deprecation date is a warning, not a silent pass", () => {
    expect(checkModel("@cf/a/m", good(planned("soon")), today)).toEqual({
      problems: [],
      warnings: ['unreadable planned_deprecation_date "soon"'],
    });
  });

  it("warns when the catalogue says reasoning_effort does not support max_tokens", () => {
    const entry = good({ properties: [{ property_id: "reasoning_effort", value: { supports_max_tokens: false } }] });
    const result = checkModel("@cf/a/m", entry, today);
    expect(result.problems).toEqual([]);
    expect(result.warnings.join(" ")).toContain("max_tokens");
  });

  it("does not crash on properties that are not a list", () => {
    expect(checkModel("@cf/a/m", good({ properties: "nope" as never }), today)).toEqual({ problems: [], warnings: [] });
  });

  it("an input split across allOf parts still counts as one input", () => {
    const split = { allOf: [{ properties: { messages: {} } }, { properties: { max_tokens: {} } }] };
    expect(checkModel("@cf/a/m", good({ schema: { input: split, output } }), today).problems).toEqual([]);
  });

  it("an alternative inherits the properties its parent declares", () => {
    const shared = { properties: { max_tokens: {} }, oneOf: [{ properties: { prompt: {} } }, { properties: { messages: {} } }] };
    expect(checkModel("@cf/a/m", good({ schema: { input: shared, output } }), today).problems).toEqual([]);
  });
});

describe("check-models: script", () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  const healthy = (name: string): CatalogueEntry => ({
    name,
    deprecated: false,
    task: { name: "Text Generation" },
    properties: [],
    schema: {
      input: { oneOf: [{ properties: { messages: {}, max_tokens: {} } }] },
      output: { properties: { response: {} } },
    },
  });

  /** Serves `entries` (file name -> entry); anything else is 404. */
  async function catalogue(entries: Record<string, CatalogueEntry>) {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      const path = req.url ?? "";
      paths.push(path);
      const entry = entries[path.slice(1)];
      res.writeHead(entry === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(entry === undefined ? "{}" : JSON.stringify(entry));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { url: `http://127.0.0.1:${address.port}`, paths, server };
  }

  function run(url: string, ids: string[], script = CHECK_MODELS) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [script, ...ids],
        { timeout: 20_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POLYSTELLA_CATALOGUE_URL: url } },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr }),
      );
    });
  }

  it("exits 0 when every model is fine, and checks exactly the ids given", async () => {
    const { url, paths } = await catalogue({
      "glm-4.7-flash.json": healthy("@cf/zai-org/glm-4.7-flash"),
      "one.json": healthy("@cf/a/one"),
    });
    const result = await run(url, ["@cf/zai-org/glm-4.7-flash", "@cf/a/one"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ok    @cf/zai-org/glm-4.7-flash");
    expect(result.stdout).toContain("2 models, 0 with problems");
    expect([...paths].sort()).toEqual(["/glm-4.7-flash.json", "/one.json"]);
  });

  it("exits 1 and names a deprecated model", async () => {
    const { url } = await catalogue({
      "good.json": healthy("@cf/a/good"),
      "old.json": { ...healthy("@cf/a/old"), deprecated: true },
    });
    const result = await run(url, ["@cf/a/good", "@cf/a/old"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  @cf/a/old");
    expect(result.stdout).toContain("marked deprecated");
    expect(result.stdout).toContain("ok    @cf/a/good");
    expect(result.stdout).toContain("1 with problems");
  });

  it("exits 1 with 'not in the catalogue' for a 404", async () => {
    const { url } = await catalogue({ "good.json": healthy("@cf/a/good") });
    const result = await run(url, ["@cf/a/good", "@cf/a/gone"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL  @cf/a/gone");
    expect(result.stdout).toContain("not in the catalogue");
  });

  it("still runs when started through a symlink", async () => {
    const directory = mkdtempSync(join(tmpdir(), "check-models-link-"));
    try {
      const link = join(directory, "check.mjs");
      symlinkSync(CHECK_MODELS, link);
      const { url, server } = await catalogue({});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // An unreachable catalogue exits 2 only if the script really ran; a skipped main block would exit 0 silently.
      const result = await run(url, ["@cf/a/one"], link);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("could not read the catalogue");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exits 2 with a message on stderr when the catalogue is unreachable", async () => {
    const { url, server } = await catalogue({});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await run(url, ["@cf/a/one"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("could not read the catalogue");
  });

  it("exits 2 when the catalogue answers with a server error", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const result = await run(`http://127.0.0.1:${address.port}`, ["@cf/a/one"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("answered 500");
  });
});
