import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { default as ts } from 'typescript';
import { isTestArtifact } from './artifact-predicates.js';
import { REPO_ROOT } from './paths.js';

const SOURCE_ROOTS = ['src', 'tools/audit', 'tools/release'] as const;

function walkSourceFiles(repoRoot: string, dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkSourceFiles(repoRoot, rel, out);
    } else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
}

/**
 * Repo-relative paths of every non-test TypeScript module under the source roots.
 * `statSync` keeps the walk honest about symlinked roots. The result is
 * de-duplicated, so a nested source root does not inflate the count.
 */
export function enumerateProductionModules(repoRoot: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    try {
      if (!statSync(join(repoRoot, root)).isDirectory()) continue;
    } catch {
      continue;
    }
    walkSourceFiles(repoRoot, root, out);
  }
  return [...new Set(out)].filter((p) => !isTestArtifact(p)).sort();
}

/**
 * Every module specifier that a source file imports or re-exports, read from the parsed syntax tree.
 * It reads static declarations and dynamic `import('…')` calls. A package name in a comment or a plain string is not an import.
 * The dynamic half is necessary, because `src/index.ts` loads the MCP adapter only through a lazy `import()`.
 */
export function collectImportSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        out.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/** Resolve a relative ESM specifier (`./x.js`) from `fromFile` to a repo-relative `.ts` path. */
export function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return joined.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
}

/**
 * Artifacts that at least one non-test module imports.
 * This set is independent of CI reachability. A module can run in CI through its co-located vitest and still have no production caller.
 */
export function productionImportedSet(repoRoot: string = REPO_ROOT): Set<string> {
  const modules = enumerateProductionModules(repoRoot);
  const imported = new Set<string>();
  for (const file of modules) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const specifier of collectImportSpecifiers(source, file)) {
      const target = resolveRelativeSpecifier(file, specifier);
      if (target !== null && target !== file) imported.add(target);
    }
  }
  return imported;
}
