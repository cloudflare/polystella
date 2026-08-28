import { builtinModules } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const PACKAGE_NAMES = ["core", "adapters", "providers"] as const;
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const FORBIDDEN_PACKAGES = new Set(["astro", "react", "react-dom", "satteri", "dotenv", "std-env", "wrangler"]);

interface ModuleReference {
  specifier: string;
  runtime: boolean;
}

describe.each(PACKAGE_NAMES)("packages/%s boundary", (packageName) => {
  it("has only portable, declared source imports", async () => {
    const packageRoot = join(ROOT, "packages", packageName);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const declaredRuntimeDependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    const violations: string[] = [];

    for (const filePath of await listTypeScriptFiles(join(packageRoot, "src"))) {
      const source = await readFile(filePath, "utf8");
      violations.push(...sourceViolations(source, relative(ROOT, filePath), manifest.name, declaredRuntimeDependencies));
    }

    for (const dependencyName of declaredRuntimeDependencies) {
      if (isForbidden(dependencyName))
        violations.push(`packages/${packageName}/package.json: forbidden runtime dependency ${dependencyName}`);
    }

    expect(violations).toEqual([]);
  });
});

describe("boundary analyzer regressions", () => {
  it.each([
    ["bare Node builtins", 'import "fs"', "forbidden import fs"],
    ["node: builtins", 'import "node:fs"', "forbidden import node:fs"],
    ["Astro", 'import "astro"', "forbidden import astro"],
    ["Satteri", 'import "satteri"', "forbidden import satteri"],
    ["undeclared packages", 'import "left-pad"', "undeclared runtime import left-pad"],
    ["unsupported protocols", 'import "npm:left-pad"', "unsupported protocol import npm:left-pad"],
    ["process", "process.env.API_KEY", "forbidden Node global process"],
    ["Buffer", 'Buffer.from("x")', "forbidden Node global Buffer"],
    ["globalThis.process", "globalThis.process.env.API_KEY", "forbidden Node global process"],
    ["globalThis.Buffer", 'globalThis.Buffer.from("x")', "forbidden Node global Buffer"],
    ["parenthesized globalThis", "(globalThis).process.env.API_KEY", "forbidden Node global process"],
    ["asserted globalThis", '(globalThis as typeof globalThis).Buffer.from("x")', "forbidden Node global Buffer"],
    ["globalThis element access", 'globalThis["Buffer"].from("x")', "forbidden Node global Buffer"],
    ["ambient process", "declare const process: { env: object }; process.env", "forbidden Node global process"],
    ["ambient Buffer", 'declare class Buffer { static from(value: string): Buffer } Buffer.from("x")', "forbidden Node global Buffer"],
  ])("rejects %s", (_name, source, expected) => {
    expect(sourceViolations(source, "fixture.ts", "test-package", new Set())).toContainEqual(expect.stringContaining(expected));
  });

  it("allows declarations and property names matching Node globals", () => {
    const source = "const process = 1; class Buffer {} const value = { process: true, Buffer: true }; value.process; value.Buffer";
    expect(sourceViolations(source, "fixture.ts", "test-package", new Set())).toEqual([]);
  });

  it.each([
    ["variable", "const process = { env: {} }; process.env.API_KEY", new Set<string>()],
    ["parameter", "function read(process: { env: object }) { return process.env }", new Set<string>()],
    ["class", 'class Buffer { static from(_value: string) {} } Buffer.from("x")', new Set<string>()],
    ["import", 'import Buffer from "portable-buffer"; Buffer.from("x")', new Set(["portable-buffer"])],
  ])("allows a locally bound Node-global name from a %s", (_name, source, dependencies) => {
    expect(sourceViolations(source, "fixture.ts", "test-package", dependencies)).toEqual([]);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
    else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function collectModuleReferences(source: string, filePath: string): ModuleReference[] {
  const sourceFile = createSourceFile(source, filePath);
  const references: ModuleReference[] = [];
  const add = (node: ts.Expression | ts.LiteralTypeNode, runtime: boolean): void => {
    const literal = ts.isLiteralTypeNode(node) ? node.literal : node;
    if (ts.isStringLiteralLike(literal)) references.push({ specifier: literal.text, runtime });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const runtime =
        clause === undefined ||
        (!clause.isTypeOnly &&
          (clause.name !== undefined ||
            clause.namedBindings === undefined ||
            ts.isNamespaceImport(clause.namedBindings) ||
            clause.namedBindings.elements.some((element) => !element.isTypeOnly)));
      add(node.moduleSpecifier, runtime);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, !node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(node.argument, false);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined) add(argument, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function sourceViolations(source: string, filePath: string, packageName: string, declaredDependencies: Set<string>): string[] {
  const violations: string[] = [];
  for (const reference of collectModuleReferences(source, filePath)) {
    const dependencyName = packageNameFromSpecifier(reference.specifier);
    if (hasUnsupportedProtocol(reference.specifier)) {
      violations.push(`${filePath}: unsupported protocol import ${reference.specifier}`);
    } else if (isForbidden(reference.specifier)) {
      violations.push(`${filePath}: forbidden import ${reference.specifier}`);
    }
    if (
      reference.runtime &&
      dependencyName !== undefined &&
      dependencyName !== packageName &&
      !isNodeBuiltin(reference.specifier) &&
      !declaredDependencies.has(dependencyName)
    ) {
      violations.push(`${filePath}: undeclared runtime import ${reference.specifier}`);
    }
  }

  const sourceFile = createSourceFile(source, filePath);
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.fileExists = (candidate) => candidate === filePath;
  host.readFile = (candidate) => (candidate === filePath ? source : undefined);
  host.getSourceFile = (candidate) => (candidate === filePath ? sourceFile : undefined);
  const checker = ts.createProgram([filePath], options, host).getTypeChecker();
  const visit = (node: ts.Node): void => {
    const globalMember = readGlobalThisMember(node, checker, sourceFile);
    if (globalMember !== undefined) {
      violations.push(`${filePath}: forbidden Node global ${globalMember}`);
    } else if (
      ts.isIdentifier(node) &&
      (node.text === "process" || node.text === "Buffer") &&
      isIdentifierUse(node) &&
      !isLocallyBound(node, checker, sourceFile)
    ) {
      violations.push(`${filePath}: forbidden Node global ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

function isLocallyBound(node: ts.Identifier, checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  return (
    checker
      .getSymbolAtLocation(node)
      ?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile && isRuntimeBinding(declaration)) === true
  );
}

function isRuntimeBinding(declaration: ts.Declaration): boolean {
  if (declaration.getSourceFile().isDeclarationFile) return false;
  for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      return false;
  }
  if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
  if (ts.isImportSpecifier(declaration)) return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
  if (ts.isNamespaceImport(declaration)) return !declaration.parent.parent.isTypeOnly;
  return (
    ts.isVariableDeclaration(declaration) ||
    ts.isBindingElement(declaration) ||
    ts.isParameter(declaration) ||
    ts.isFunctionLike(declaration) ||
    ts.isClassLike(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  );
}

function readGlobalThisMember(node: ts.Node, checker: ts.TypeChecker, sourceFile: ts.SourceFile): "process" | "Buffer" | undefined {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const expression = unwrapExpression(node.expression);
  if (!ts.isIdentifier(expression) || expression.text !== "globalThis" || isLocallyBound(expression, checker, sourceFile)) return undefined;
  const name = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  return name === "process" || name === "Buffer" ? name : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function createSourceFile(source: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function isIdentifierUse(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isNamedDeclaration(parent) && parent.name === node) return false;
  return true;
}

function isForbidden(specifier: string): boolean {
  if (isNodeBuiltin(specifier) || specifier.startsWith("astro:") || specifier.startsWith("cloudflare:")) return true;
  const dependencyName = packageNameFromSpecifier(specifier);
  return dependencyName !== undefined && (FORBIDDEN_PACKAGES.has(dependencyName) || dependencyName.startsWith("@astrojs/"));
}

function hasUnsupportedProtocol(specifier: string): boolean {
  const protocol = /^([a-z][a-z+.-]*):/i.exec(specifier)?.[1];
  return protocol !== undefined && protocol !== "node" && protocol !== "astro" && protocol !== "cloudflare";
}

function isNodeBuiltin(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/, "");
  return specifier.startsWith("node:") || NODE_BUILTINS.has(normalized);
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || specifier.includes(":")) return undefined;
  const [scopeOrName, name] = specifier.split("/");
  return scopeOrName?.startsWith("@") ? (name === undefined ? scopeOrName : `${scopeOrName}/${name}`) : scopeOrName;
}
