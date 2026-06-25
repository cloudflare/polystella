import { readFile } from "node:fs/promises";
import path from "node:path";

import { resolveOptions } from "../config/options.js";
import { markdownAdapter } from "../parsing/adapters/markdown.js";
import { auditMdxAst, type MdxAuditFinding } from "../parsing/mdx-audit.js";
import { normalizeMdxRulesForSource } from "../parsing/mdx-rules.js";
import { walkSources } from "../source/walk.js";
import { loadAstroI18n, loadPolystellaConfig } from "./i18n-config.js";

export const AUDIT_MDX_USAGE = `polystella audit-mdx

Scan MDX sources for likely missed translation opportunities. Runs offline:
no provider, no R2, no writes.

Usage:
  polystella audit-mdx [flags]

Flags:
  --file <glob>   Replace configured include globs with one sourceDir-relative glob.
  --json          Emit structured JSON instead of human-readable text.
  --help          Print this message.
`;

export interface AuditMdxArgs {
  file?: string | undefined;
  json: boolean;
  help: boolean;
}

export interface AuditMdxDeps {
  cwd: string;
  log: (msg: string) => void;
  err: (msg: string) => void;
}

export function parseAuditMdxArgs(argv: ReadonlyArray<string>): AuditMdxArgs {
  const out: AuditMdxArgs = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--file": {
        const value = argv[++i];
        if (!value || value.startsWith("--")) {
          throw new Error(`--file requires a value (got: ${value ?? "<end>"})`);
        }
        out.file = value;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return out;
}

export async function runAuditMdx(args: AuditMdxArgs, deps: AuditMdxDeps): Promise<number> {
  if (args.help) {
    deps.log(AUDIT_MDX_USAGE);
    return 0;
  }

  let resolved;
  try {
    const [astroI18n, rawConfig] = await Promise.all([loadAstroI18n(deps.cwd), loadPolystellaConfig(deps.cwd)]);
    resolved = resolveOptions(rawConfig, astroI18n);
  } catch (err) {
    deps.err(`[polystella] ${(err as Error).message}`);
    return 1;
  }

  const sourceDir = path.resolve(deps.cwd, resolved.sourceDir);
  const sources = await walkSources({
    roots: [
      {
        baseDir: sourceDir,
        include: args.file !== undefined ? [args.file] : resolved.include,
        exclude: resolved.exclude,
      },
    ],
  });

  const findings: MdxAuditFinding[] = [];
  for (const source of sources) {
    if (!source.relativePath.toLowerCase().endsWith(".mdx")) continue;
    const body = await readFile(source.absolutePath, "utf8");
    const parsed = markdownAdapter.parse(body, source.relativePath);
    const mdxRules = normalizeMdxRulesForSource(resolved.markdown.mdx, source.relativePath);
    findings.push(...auditMdxAst(parsed, { sourcePath: source.relativePath, mdxRules }));
  }

  if (args.json) {
    deps.log(JSON.stringify({ findings }, null, 2));
    return 0;
  }

  if (findings.length === 0) {
    deps.log("[polystella] audit-mdx: no findings.");
    return 0;
  }

  deps.log(`[polystella] audit-mdx: ${findings.length} finding${findings.length === 1 ? "" : "s"} (warn-only).`);
  for (const finding of findings) {
    deps.log(`\n${finding.sourcePath}:${finding.line}:${finding.column} [${finding.severity}] ${finding.code}`);
    deps.log(`  ${finding.message}`);
    deps.log(`  Text: ${JSON.stringify(finding.text)}`);
    deps.log(`  Suggestion: ${finding.suggestion}`);
  }
  return 0;
}
