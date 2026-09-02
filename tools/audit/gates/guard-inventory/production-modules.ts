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
 * `statSync` keeps the walk honest about symlinked roots.
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
  // De-duplicated so a future nested root inflates nothing: the roots above are
  // disjoint today, and this keeps the denominator honest if that stops holding.
  return [...new Set(out)].filter((p) => !isTestArtifact(p)).sort();
}

/**
 * Every module specifier imported (or re-exported) by a source file, PARSED —
 * static declarations AND dynamic `import('…')` calls.
 *
 * Task 061 and task 062 both had to correct scanners that matched specifiers as
 * raw text; a package named only in a comment or a template literal is not an
 * import. `ts.isImportDeclaration` cannot disagree with the compiler about what
 * an import is.
 *
 * The dynamic half is not optional. `src/index.ts` reaches
 * `adapters/mcp.ts` ONLY through `await import('.././adapters/mcp.js')` — a
 * deliberate lazy edge that keeps the MCP SDK off the CLI's cold-start path. A
 * static-only scan reports the repo's MCP adapter as having no production caller,
 * which would have put a false R-11 finding in this inventory on day one.
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
 * Artifacts imported by at least one NON-test module.
 *
 * This is the R-11 axis and it is deliberately independent of CI reachability:
 * `resolveDispatchShape` is executed on every MCP-touching PR through its
 * co-located vitest and still has no production caller.
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

// ─── Exemption register (the one hand-maintained input) ──────────────────────

/** The finding an exemption is allowed to excuse. One entry excuses exactly one. */
