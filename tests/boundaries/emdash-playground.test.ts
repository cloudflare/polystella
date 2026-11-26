import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The playground options import the plugin's built `dist` (`@cloudflare/polystella-emdash/config`); `pnpm test:boundaries` builds it first.
const ROOT = process.cwd();
const PLAYGROUND = join(ROOT, "playgrounds", "emdash");
const SEED_EXTRAS = join(PLAYGROUND, "scripts", "seed-extras.mjs");
const SMOKE = join(PLAYGROUND, "scripts", "smoke.mjs");

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("emdash playground stays in step with packages/emdash", () => {
  const playground = readJson<Manifest>(join(PLAYGROUND, "package.json"));
  const plugin = readJson<Manifest>(join(ROOT, "packages", "emdash", "package.json"));
  const pinned = playground.devDependencies ?? {};
  const tested = plugin.devDependencies ?? {};

  it.each(["emdash", "@emdash-cms/admin", "@cloudflare/kumo"])("pins %s to the version packages/emdash is tested with", (name) => {
    expect(
      pinned[name],
      `playgrounds/emdash/package.json pins ${name}@${pinned[name]} but packages/emdash tests ${tested[name]}; bump the playground pin to ${tested[name]}`,
    ).toBe(tested[name]);
  });

  it("lists everything under devDependencies so `pnpm audit --prod` only covers published code", () => {
    expect(playground.dependencies).toBeUndefined();
  });

  it("pins @emdash-cms/cloudflare to the emdash version", () => {
    expect(
      pinned["@emdash-cms/cloudflare"],
      `playgrounds/emdash/package.json pins @emdash-cms/cloudflare@${pinned["@emdash-cms/cloudflare"]}; it must equal the emdash pin ${pinned.emdash}`,
    ).toBe(pinned.emdash);
  });
});

describe("emdash playground options", () => {
  let sandbox: string;

  const probe = `
    import { validatePolystellaEmdashOptions } from "@cloudflare/polystella-emdash";
    import { createPolystellaOptions } from "./polystella.options.mjs";
    const result = {};
    for (const runtime of ["node", "cloudflare"]) {
      try {
        const options = createPolystellaOptions(runtime);
        validatePolystellaEmdashOptions(options);
        result[runtime] = { options };
      } catch (error) {
        result[runtime] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    console.log(JSON.stringify(result));
  `;

  interface RuntimeResult {
    options?: {
      provider: { kind: string; endpoint?: string; accountIdEnv?: string; apiTokenEnv?: string; binding?: string };
      models: { allowed: string[]; defaults?: { default: string }; reasoningInput?: Record<string, Record<string, unknown>> };
      blockFields: Record<string, unknown>;
    };
    error?: string;
  }
  type Matrix = Record<"node" | "cloudflare", RuntimeResult>;

  beforeAll(() => {
    expect(
      existsSync(join(ROOT, "packages", "emdash", "dist", "config.js")),
      "packages/emdash/dist is missing; run `pnpm build` before the boundary tests",
    ).toBe(true);
    // A copy without the developer's real `.env`; node_modules is shared so the plugin still resolves.
    sandbox = mkdtempSync(join(tmpdir(), "polystella-playground-"));
    for (const file of ["polystella.options.mjs", "locales.mjs", "models.mjs", "package.json"])
      cpSync(join(PLAYGROUND, file), join(sandbox, file));
    cpSync(join(PLAYGROUND, "src", "i18n"), join(sandbox, "src", "i18n"), { recursive: true });
    symlinkSync(join(PLAYGROUND, "node_modules"), join(sandbox, "node_modules"), "dir");
    writeFileSync(join(sandbox, "probe.mjs"), probe);
  });

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  /** Runs the options module in a child with only PATH, HOME and `env`; `dotenv` becomes the sandbox `.env`. */
  function run(env: Record<string, string>, dotenv?: string): Matrix {
    const dotenvPath = join(sandbox, ".env");
    rmSync(dotenvPath, { force: true });
    if (dotenv !== undefined) writeFileSync(dotenvPath, dotenv);
    const stdout = execFileSync(process.execPath, ["probe.mjs"], {
      cwd: sandbox,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Matrix;
  }

  const realEnv = { POLYSTELLA_AI: "real", CLOUDFLARE_ACCOUNT_ID: "acct-1", CLOUDFLARE_WORKERS_AI_TOKEN: "secret-token-value" };

  it("defaults to the local fake and validates in both runtimes", () => {
    const matrix = run({});
    for (const runtime of ["node", "cloudflare"] as const) {
      expect(matrix[runtime].error).toBeUndefined();
      expect(matrix[runtime].options?.provider).toEqual({
        kind: "workers-ai-http",
        accountIdEnv: "POLYSTELLA_FAKE_ACCOUNT_ID",
        apiTokenEnv: "POLYSTELLA_FAKE_API_TOKEN",
        endpoint: "http://127.0.0.1:8799/workers-ai",
      });
    }
  });

  it("uses the CLOUDFLARE_* credentials from .env without an endpoint in real mode", () => {
    const matrix = run(
      {},
      Object.entries(realEnv)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
    for (const runtime of ["node", "cloudflare"] as const) {
      expect(matrix[runtime].error).toBeUndefined();
      expect(matrix[runtime].options?.provider).toEqual({
        kind: "workers-ai-http",
        accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
        apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
      });
    }
  });

  it("credentials only in the shell work on node but stop cloudflare, because the Worker never sees them", () => {
    const matrix = run(realEnv);
    expect(matrix.node.error).toBeUndefined();
    expect(matrix.node.options?.provider.apiTokenEnv).toBe("CLOUDFLARE_WORKERS_AI_TOKEN");
    expect(matrix.cloudflare.error).toContain(".env");
  });

  it("real mode without credentials: node throws pointing at .env.example, cloudflare uses the AI binding", () => {
    const matrix = run({ POLYSTELLA_AI: "real" });
    expect(matrix.node.error).toContain(".env.example");
    expect(matrix.cloudflare.error).toBeUndefined();
    expect(matrix.cloudflare.options?.provider).toEqual({ kind: "workers-ai-binding", binding: "AI" });
  });

  it("credentials alone stay in fake mode and the token never reaches the options", () => {
    const credentialsOnly = {
      CLOUDFLARE_ACCOUNT_ID: realEnv.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_WORKERS_AI_TOKEN: realEnv.CLOUDFLARE_WORKERS_AI_TOKEN,
    };
    const matrix = run(credentialsOnly);
    for (const runtime of ["node", "cloudflare"] as const) {
      expect(matrix[runtime].options?.provider.endpoint).toBe("http://127.0.0.1:8799/workers-ai");
      expect(JSON.stringify(matrix[runtime].options)).not.toContain("secret-token-value");
    }
  });

  it("ships a broad model list with DeepSeek V4.1 Flash first and no explicit default", () => {
    const { allowed, defaults } = run({}).node.options!.models;
    expect(defaults).toBeUndefined();
    expect(allowed[0]).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
    expect(allowed.length).toBeGreaterThan(10);
    expect(new Set(allowed).size).toBe(allowed.length);
    for (const model of allowed) expect(model, `${model} is not a Workers AI model id`).toMatch(/^@cf\/[\w.-]+\/[\w.-]+$/);
  });

  describe("thinking choices (reasoningInput)", () => {
    it("fake mode offers them only for allowed models, as effort name -> object", () => {
      const { allowed, reasoningInput } = run({}).node.options!.models;
      expect(reasoningInput).toBeDefined();
      for (const [model, efforts] of Object.entries(reasoningInput!)) {
        expect(allowed, `${model} has thinking choices but is not allowed`).toContain(model);
        expect(Object.keys(efforts).length).toBeGreaterThan(0);
        for (const value of Object.values(efforts)) expect(typeof value === "object" && value !== null).toBe(true);
      }
      expect(Object.keys(reasoningInput!["@cf/deepseek-ai/deepseek-v4.1-flash-1017"]!).sort()).toEqual(["high", "low", "max", "none"]);
      expect(Object.keys(reasoningInput!["@cf/zai-org/glm-4.7-flash"]!).sort()).toEqual(["none", "on"]);
    });

    it("a model with no thinking entry leaves reasoningInput empty and the options valid", () => {
      const matrix = run({ POLYSTELLA_AI_MODELS: "@cf/ibm-granite/granite-4.0-h-micro" });
      for (const runtime of ["node", "cloudflare"] as const) {
        expect(matrix[runtime].error).toBeUndefined();
        expect(Object.keys(matrix[runtime].options?.models.reasoningInput ?? {})).toEqual([]);
      }
    });

    it("drops thinking entries of models the override removed, and the options still validate", () => {
      const matrix = run({ POLYSTELLA_AI_MODELS: "@cf/zai-org/glm-4.7-flash" });
      expect(matrix.node.error).toBeUndefined();
      expect(Object.keys(matrix.node.options!.models.reasoningInput!)).toEqual(["@cf/zai-org/glm-4.7-flash"]);
    });

    it("real mode passes none, so the plugin reads the live catalogue", () => {
      const matrix = run(realEnv);
      expect(matrix.node.error).toBeUndefined();
      expect(matrix.node.options!.models.reasoningInput).toBeUndefined();
    });
  });

  it("treats a blank POLYSTELLA_AI_MODELS as unset", () => {
    const shipped = run({}).node.options!.models;
    expect(run({ POLYSTELLA_AI_MODELS: "" }).node.options!.models).toEqual(shipped);
    expect(run({ POLYSTELLA_AI_MODELS: " , " }).node.options!.models).toEqual(shipped);
  });

  it("reads POLYSTELLA_AI_MODELS: trims and allows all, leaving the default to the plugin", () => {
    const matrix = run({ POLYSTELLA_AI_MODELS: "@cf/a/one, @cf/b/two" });
    expect(matrix.node.options?.models.allowed).toEqual(["@cf/a/one", "@cf/b/two"]);
    expect(matrix.node.options?.models.defaults).toBeUndefined();
  });

  it("loads .env next to the options file, and a shell variable wins over it", () => {
    const dotenv = `POLYSTELLA_AI=real\nCLOUDFLARE_ACCOUNT_ID=acct-from-file\nCLOUDFLARE_WORKERS_AI_TOKEN=token-from-file\n`;
    expect(run({}, dotenv).node.options?.provider).toEqual({
      kind: "workers-ai-http",
      accountIdEnv: "CLOUDFLARE_ACCOUNT_ID",
      apiTokenEnv: "CLOUDFLARE_WORKERS_AI_TOKEN",
    });
    expect(run({ POLYSTELLA_AI: "fake" }, dotenv).node.options?.provider.endpoint).toBe("http://127.0.0.1:8799/workers-ai");
  });

  it("has a blockFields entry for exactly the seeded block types", () => {
    const seeded = (readJson<{ blockTypes?: { slug: string }[] }>(join(PLAYGROUND, "seed", "seed.json")).blockTypes ?? []).map(
      (block) => block.slug,
    );
    expect(seeded.length).toBeGreaterThan(0);
    expect(Object.keys(run({}).node.options?.blockFields ?? {}).sort()).toEqual(seeded.sort());
  });
});

describe("emdash playground options: bad POLYSTELLA_AI", () => {
  it("throws at import with a message naming the allowed values", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "polystella-playground-bogus-"));
    try {
      for (const file of ["polystella.options.mjs", "locales.mjs", "models.mjs"]) cpSync(join(PLAYGROUND, file), join(sandbox, file));
      cpSync(join(PLAYGROUND, "src", "i18n"), join(sandbox, "src", "i18n"), { recursive: true });
      symlinkSync(join(PLAYGROUND, "node_modules"), join(sandbox, "node_modules"), "dir");
      writeFileSync(join(sandbox, "probe.mjs"), `import "./polystella.options.mjs";`);
      let stderr = "";
      try {
        execFileSync(process.execPath, ["probe.mjs"], {
          cwd: sandbox,
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", POLYSTELLA_AI: "bogus" },
          stdio: "pipe",
        });
      } catch (error) {
        stderr = String((error as { stderr?: Buffer }).stderr ?? "");
      }
      expect(stderr).toContain('POLYSTELLA_AI must be "fake" or "real"');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("emdash playground seed and locales", () => {
  interface Seed {
    blockTypes?: { slug: string }[];
  }

  it("passes EmDash's own seed validator", async () => {
    const require = createRequire(join(PLAYGROUND, "package.json"));
    const { validateSeed } = (await import(pathToFileURL(require.resolve("emdash/seed")).href)) as {
      validateSeed: (seed: unknown) => { valid: boolean; errors: string[] };
    };
    const result = validateSeed(readJson<Seed>(join(PLAYGROUND, "seed", "seed.json")));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("has a catalog and a glossary for every non-default locale", async () => {
    const { defaultLocale, locales } = (await import(pathToFileURL(join(PLAYGROUND, "locales.mjs")).href)) as {
      defaultLocale: string;
      locales: string[];
    };
    expect(locales).toContain(defaultLocale);
    const catalogs = readdirSync(join(PLAYGROUND, "src", "i18n"));
    const glossaries = readdirSync(join(PLAYGROUND, "src", "i18n", "glossary"));
    for (const locale of locales) {
      expect(catalogs, `src/i18n/${locale}.json is missing`).toContain(`${locale}.json`);
      if (locale !== defaultLocale) expect(glossaries, `src/i18n/glossary/${locale}.yaml is missing`).toContain(`${locale}.yaml`);
    }
  });
});

describe("emdash playground scripts that sign in with dev-bypass", () => {
  interface Recorded {
    method: string;
    url: string;
    cookie: string | undefined;
    emdashHeader: string | undefined;
    body: unknown;
  }

  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  async function listen(
    handler: (request: Recorded, respond: (status: number, body: string, headers?: Record<string, string>) => void) => void,
  ) {
    const requests: Recorded[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const recorded: Recorded = {
          method: req.method ?? "",
          url: req.url ?? "",
          cookie: req.headers.cookie,
          emdashHeader: req.headers["x-emdash-request"] as string | undefined,
          body: raw === "" ? undefined : JSON.parse(raw),
        };
        requests.push(recorded);
        handler(recorded, (status, body, headers = {}) => {
          res.writeHead(status, headers);
          res.end(body);
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { origin: `http://127.0.0.1:${address.port}`, requests };
  }

  function runScript(args: string[], script = SEED_EXTRAS) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [script, ...args], { timeout: 20_000 }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
      });
    });
  }

  it("exits 1 with usage when no origin is given", async () => {
    const result = await runScript([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses a server that is not the playground after exactly one GET /", async () => {
    const { origin, requests } = await listen((_request, respond) => respond(200, "<title>Some other site</title>"));
    const result = await runScript([origin]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not look like a local copy of the PolyStella EmDash playground");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /"]);
  });

  it("refuses an address that is not local without any request", async () => {
    const result = await runScript(["http://example.com"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a local address");
  });

  it("refuses a page that only looks like the playground by title", async () => {
    const { origin, requests } = await listen((_request, respond) => respond(200, "<title>PolyStella EmDash demo</title>"));
    const result = await runScript([origin]);
    expect(result.code).toBe(1);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /"]);
  });

  it("does not follow a redirect to a page that carries the marker", async () => {
    const { origin, requests } = await listen((request, respond) =>
      request.url === "/"
        ? respond(302, "", { location: "/playground" })
        : respond(200, '<meta name="polystella-playground" content="emdash" />'),
    );
    const result = await runScript([origin]);
    expect(result.code).toBe(1);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual(["GET /"]);
  });

  function playgroundServer(existingSlugs: string[]) {
    return listen((request, respond) => {
      const json = { "content-type": "application/json" };
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && path === "/")
        return respond(200, '<meta name="polystella-playground" content="emdash" /><title>PolyStella EmDash demo</title>');
      if (path === "/_emdash/api/setup/dev-bypass") return respond(302, "", { location: "/", "set-cookie": "astro-session=abc; Path=/" });
      const items = existingSlugs.map((slug, index) => ({ id: slug === "welcome" ? "w1" : `x${index}`, slug }));
      if (request.method === "GET" && request.url === "/_emdash/api/content/posts?locale=en-US&limit=100")
        return respond(200, JSON.stringify({ success: true, data: { items } }), json);
      if (request.method === "PUT" && path === "/_emdash/api/content/posts/w1")
        return respond(200, JSON.stringify({ success: true, data: {} }), json);
      if (request.method === "POST" && path === "/_emdash/api/content/posts")
        return respond(200, JSON.stringify({ success: true, data: { item: { id: "n1" } } }), json);
      if (request.method === "POST" && path === "/_emdash/api/content/posts/n1/publish")
        return respond(200, JSON.stringify({ success: true, data: {} }), json);
      respond(404, JSON.stringify({ success: false, error: "unexpected request" }), json);
    });
  }

  it("sets SEO on welcome, creates and publishes a long-guide big enough to split", async () => {
    const { origin, requests } = await playgroundServer(["welcome"]);
    const result = await runScript([origin]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const api = requests.filter((request) => request.url.startsWith("/_emdash/api/content"));
    expect(api.length).toBe(4);
    for (const request of api) {
      expect(request.cookie).toBe("astro-session=abc");
      expect(request.emdashHeader).toBe("1");
    }

    const put = requests.find((request) => request.method === "PUT");
    expect(put?.url).toBe("/_emdash/api/content/posts/w1");
    const seo = (put?.body as { seo: { title: string; description: string } }).seo;
    expect(seo.title.length).toBeGreaterThan(0);
    expect(seo.description.length).toBeGreaterThan(0);

    const post = requests.find((request) => request.method === "POST" && request.url === "/_emdash/api/content/posts");
    const body = post?.body as { slug: string; locale: string; data: { content: { children: { text: string }[] }[] } };
    expect(body.slug).toBe("long-guide");
    expect(body.locale).toBe("en-US");
    const texts = body.data.content.flatMap((block) => block.children.map((child) => child.text));
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.join("").length).toBeGreaterThan(30_000);

    expect(requests.some((request) => request.method === "POST" && request.url === "/_emdash/api/content/posts/n1/publish")).toBe(true);
  });

  it("does not create long-guide again when it exists", async () => {
    const { origin, requests } = await playgroundServer(["welcome", "long-guide"]);
    const result = await runScript([origin]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("long-guide already exists");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
  describe("smoke", () => {
    const get = (requests: Recorded[]) => requests.map((request) => `${request.method} ${request.url}`);

    it("exits 1 with usage when no origin is given", async () => {
      const result = await runScript([], SMOKE);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("usage:");
    });

    it("rejects a phase that belongs to the other mode before any request", async () => {
      const { origin, requests } = await listen((_request, respond) => respond(404, "{}"));
      for (const args of [
        [origin, "sweep"],
        [origin, "--real", "base"],
      ]) {
        const result = await runScript(args, SMOKE);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("usage:");
      }
      expect(requests).toEqual([]);
    });

    it("refuses an address that is not local without any request", async () => {
      const result = await runScript(["http://example.com"], SMOKE);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("not a local address");
    });

    it("refuses a server that is not the playground after exactly one GET /", async () => {
      const { origin, requests } = await listen((_request, respond) => respond(200, "<title>Some other site</title>"));
      const result = await runScript([origin], SMOKE);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("does not look like a local copy of the PolyStella EmDash playground");
      expect(get(requests)).toEqual(["GET /"]);
    });

    async function serverAnsweringTheSandbox(translation: string) {
      return listen((request, respond) => {
        const json = { "content-type": "application/json" };
        const path = request.url.split("?")[0] ?? "";
        if (request.method === "GET" && path === "/") return respond(200, '<meta name="polystella-playground" content="emdash" />');
        if (path === "/_emdash/api/setup/dev-bypass") return respond(302, "", { "set-cookie": "astro-session=abc; Path=/" });
        if (path === "/_emdash/api/plugins/polystella/settings/translation")
          return respond(200, JSON.stringify({ success: true, data: { allowedModels: ["@cf/a/m"] } }), json);
        if (path === "/_emdash/api/plugins/polystella/translation-sandbox")
          return respond(200, JSON.stringify({ success: true, data: { translation } }), json);
        respond(404, JSON.stringify({ success: false, error: "unexpected request" }), json);
      });
    }

    const writes = (requests: Recorded[]) => get(requests.filter((request) => request.method !== "GET"));

    it("refuses --real against the fake AI after one probe request and no writes", async () => {
      const { origin, requests } = await serverAnsweringTheSandbox("[ja-JP] Hello");
      const result = await runScript([origin, "--real"], SMOKE);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("using the fake AI");
      expect(writes(requests)).toEqual(["POST /_emdash/api/plugins/polystella/translation-sandbox"]);
    });

    it("refuses the free checks against real AI after one probe request and no writes", async () => {
      const { origin, requests } = await serverAnsweringTheSandbox("こんにちは");
      const result = await runScript([origin], SMOKE);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("would spend money");
      expect(writes(requests)).toEqual(["POST /_emdash/api/plugins/polystella/translation-sandbox"]);
    });

    const GLM_FLASH = "@cf/zai-org/glm-4.7-flash";
    const BASE_MODELS = [
      GLM_FLASH,
      "@cf/qwen/qwen3.8-27b",
      "@cf/zai-org/glm-5.3",
      "@cf/openai/gpt-oss-120b",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    ];
    const ORIGINAL_SETTINGS = {
      debugEnabled: false,
      clearAiFlagOnEdit: true,
      translateSeoWhenPublished: false,
      maxTokens: 7000,
      model: null,
      reasoning: null,
      locales: [
        { locale: "ja-JP", model: null, reasoning: null, glossaryMode: "merge", glossaryText: "" },
        { locale: "ar-SA", model: null, reasoning: null, glossaryMode: "merge", glossaryText: "" },
      ],
      instructions: { mode: "append", text: "keep brand names" },
    };

    interface SettingsBody {
      revision: number;
      model: string | null;
      reasoning: string | null;
      locales: Record<string, Record<string, unknown>>;
      [key: string]: unknown;
    }

    /** A playground with no queue whose Translation settings live in memory, so a test can see what the script left behind. */
    async function statefulPlayground(options: {
      translation: string;
      models: string[];
      slugs: string[];
      translateFails?: boolean;
      withoutNotice?: boolean;
    }) {
      let settings: Record<string, unknown> = {
        ...ORIGINAL_SETTINGS,
        revision: 1,
        defaultModel: options.models[0],
        allowedModels: options.models,
      };
      const ids: Record<string, string> = { welcome: "w", "partner-update": "p", home: "h" };
      const json = { "content-type": "application/json" };
      const ok = (data: unknown) => JSON.stringify({ success: true, data });
      const fail = (message: string) => JSON.stringify({ success: false, error: { message } });
      const server = await listen((request, respond) => {
        const [path = "", query = ""] = request.url.split("?");
        const route = path.replace("/_emdash/api/plugins/polystella/", "");
        const body = request.body as (SettingsBody & Record<string, unknown>) | undefined;
        if (request.method === "GET" && path === "/") return respond(200, '<meta name="polystella-playground" content="emdash" />');
        if (path === "/_emdash/api/setup/dev-bypass") return respond(302, "", { "set-cookie": "astro-session=abc; Path=/" });
        if (route === "translation-sandbox") return respond(200, ok({ translation: options.translation }), json);
        if (route === "batch/jobs") return respond(200, ok({ queueEnabled: false, jobs: [] }), json);
        if (route === "settings/collections") return respond(200, ok({ revision: 1, policies: { posts: {} } }), json);
        if (route === "models/reasoning") return respond(200, ok({ efforts: [] }), json);
        if (route === "settings/translation" && request.method === "GET") return respond(200, ok(settings), json);
        if (route === "settings/translation" && request.method === "PUT" && body !== undefined) {
          if (body.revision !== settings.revision) return respond(409, fail("stale revision"), json);
          if (body.model === "@cf/openai/gpt-oss-120b" && body.reasoning === "none") return respond(400, fail("no such effort"), json);
          const { locales, ...rest } = body;
          settings = {
            ...settings,
            ...rest,
            revision: body.revision + 1,
            locales: Object.entries(locales).map(([locale, value]) => ({ locale, ...value })),
          };
          return respond(200, ok(settings), json);
        }
        if (route === "translate-content" && body !== undefined) {
          if (options.translateFails === true) return respond(502, fail("model refused"), json);
          const locale = (settings.locales as { locale: string; model: string | null }[]).find((item) => item.locale === body.targetLocale);
          const fields = body.fields as string[];
          return respond(
            200,
            ok({
              patch: {},
              debug: { model: locale?.model ?? settings.model ?? settings.defaultModel, requestInput: { enable_thinking: false } },
              ...(body.entryId === "p" && fields.includes("content") && options.withoutNotice !== true
                ? { notice: "custom block partner.badge is not translated" }
                : {}),
            }),
            json,
          );
        }
        const content = /^\/_emdash\/api\/content\/(\w+)$/.exec(path);
        if (request.method === "GET" && content?.[1] !== undefined) {
          const collection = content[1];
          const english = query.includes("locale=en-US");
          const items = english ? options.slugs.map((slug) => ({ id: ids[slug] ?? slug, slug })) : [];
          return respond(200, ok({ items: collection === "landing" ? items.filter((item) => item.slug === "home") : items }), json);
        }
        respond(404, fail("unexpected request"), json);
      });
      return { ...server, settings: () => settings };
    }

    const settingsPuts = (requests: Recorded[]) =>
      requests.filter((request) => request.method === "PUT" && request.url.endsWith("/settings/translation"));

    it("runs the base phase to its summary and puts the original Translation settings back", async () => {
      const playground = await statefulPlayground({
        translation: "[ja-JP] Hello",
        models: BASE_MODELS,
        slugs: ["welcome", "partner-update", "home"],
      });
      const result = await runScript([playground.origin, "base"], SMOKE);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("FAIL");
      expect(result.stdout).toContain("skipped: this runtime has no queue binding");
      expect(result.stdout).toMatch(/\n\d+ passed, 0 warnings, 0 failed\n$/);
      expect(result.code).toBe(0);

      const puts = settingsPuts(playground.requests);
      // The phase really changed settings, so the restore below is not trivially true.
      expect(puts.some((put) => (put.body as SettingsBody).model === GLM_FLASH)).toBe(true);
      expect(playground.settings()).toEqual({
        ...ORIGINAL_SETTINGS,
        revision: expect.any(Number),
        defaultModel: GLM_FLASH,
        allowedModels: BASE_MODELS,
      });
      // Nothing is written after the restore.
      const writes = playground.requests.filter((request) => request.method !== "GET");
      expect(writes.at(-1)).toBe(puts.at(-1));
    });

    it("exits 1 when a phase fails, and still restores the settings", async () => {
      const playground = await statefulPlayground({ translation: "[ja-JP] Hello", models: BASE_MODELS, slugs: ["welcome"] });
      const result = await runScript([playground.origin, "base"], SMOKE);
      expect(result.stdout).toContain("FAIL  the base phase ran to the end");
      expect(result.stdout).toContain("partner-update");
      expect(result.stdout).toMatch(/1 failed\n$/);
      expect(result.code).toBe(1);
      expect(playground.settings()).toMatchObject(ORIGINAL_SETTINGS);
    });

    it("exits 1 when one check fails inside a phase that completes", async () => {
      const playground = await statefulPlayground({
        translation: "[ja-JP] Hello",
        models: BASE_MODELS,
        slugs: ["welcome", "partner-update", "home"],
        withoutNotice: true,
      });
      const result = await runScript([playground.origin, "base"], SMOKE);
      expect(result.stdout).toContain("FAIL  the notice names the custom block type");
      expect(result.stdout).not.toContain("ran to the end");
      expect(result.stdout).toMatch(/\n\d+ passed, 0 warnings, 1 failed\n$/);
      expect(result.code).toBe(1);
      expect(playground.settings()).toMatchObject(ORIGINAL_SETTINGS);
    });

    it("counts a refused model as a warning and still exits 0", async () => {
      const playground = await statefulPlayground({
        translation: "こんにちは",
        models: ["@cf/a/m"],
        slugs: ["welcome"],
        translateFails: true,
      });
      const result = await runScript([playground.origin, "--real", "sweep"], SMOKE);
      expect(result.stdout).toContain("Real mode");
      expect(result.stdout).toContain("WARN m translates the welcome post");
      expect(result.stdout).toMatch(/\n1 passed, 1 warnings, 0 failed\n$/);
      expect(result.code).toBe(0);
      expect(playground.settings()).toMatchObject(ORIGINAL_SETTINGS);
    });
  });
});
