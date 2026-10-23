/**
 * The binary entry `src/index.ts` must reach only a small set of modules through static value
 * imports.
 *
 * Claude Code runs a hook command on every session event and every subagent write. Each run
 * evaluates the static import graph of the entry before `main()` reaches the fast path. A static
 * import of the store, the registry or the CLI builder adds about 70 ms to each of those runs.
 * This guard walks the transitive closure and fails on any module outside the allowlist.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/** The binary entry, as a path relative to the repository root. */
const ENTRY = 'src/index.ts';

/**
 * The modules the entry loads before its fast paths. A new member must stay light. It imports only
 * node built-ins, small packages and other members.
 */
const ALLOWED_CLOSURE = new Set([
  'src/index.ts',
  'src/logger.ts',
  'src/utils/paths.ts',
  'src/utils/process.ts',
  'src/adapters/cli/version.ts',
  'src/adapters/cli/hooks.ts',
]);

/** Returns the relative specifiers of the static value imports and re-exports of one module. */
function staticValueSpecifiers(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.importClause?.isTypeOnly) continue;
      const bindings = statement.importClause?.namedBindings;
      const onlyTypes =
        statement.importClause !== undefined &&
        statement.importClause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes) specifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

/** Resolves a relative `.js` specifier to its `.ts` source, as a path relative to the repository. */
function resolveSpecifier(fromFile: string, specifier: string, exists: (path: string) => boolean): string {
  const base = join(dirname(fromFile), specifier).replace(/\\/g, '/');
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`];
  return candidates.find(exists) ?? base;
}

/** Returns the transitive static value-import closure of an entry, as sorted relative paths. */
function staticClosure(
  entry: string,
  read: (path: string) => string,
  exists: (path: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const specifier of staticValueSpecifiers(read(current), current)) {
      queue.push(resolveSpecifier(current, specifier, exists));
    }
  }
  return [...seen].sort();
}

describe('entry static imports', () => {
  /** The live check: the closure of the binary entry stays inside the allowlist. */
  it('EntryModule_TransitiveStaticClosure_StaysInAllowlist', () => {
    const closure = staticClosure(
      ENTRY,
      (path) => readFileSync(join(REPO_ROOT, path), 'utf8'),
      (path) => existsSync(join(REPO_ROOT, path)),
    );
    expect(closure.filter((path) => !ALLOWED_CLOSURE.has(path)), 'modules outside the allowlist').toEqual([]);
    expect(closure, 'the walk missed an allowed module, so it is broken or the allowlist is stale').toEqual(
      [...ALLOWED_CLOSURE].sort(),
    );
  });

  /** A heavy module behind an allowed module is found, so the live check can fail. */
  it('EntryModule_SeededTransitiveHeavyEdge_Fails', () => {
    const graph: Record<string, string> = {
      'src/index.ts': "import { logger } from './logger.js';\nimport type { Big } from './registry.js';",
      'src/logger.ts': "import { getFullRegistry } from './registry.js';",
      'src/registry.ts': '',
    };
    const closure = staticClosure('src/index.ts', (path) => graph[path] ?? '', (path) => path in graph);
    expect(closure).toEqual(['src/index.ts', 'src/logger.ts', 'src/registry.ts']);
  });

  /** Type-only imports, dynamic imports and package imports do not enter the closure. */
  it('EntryModule_TypeAndDynamicImports_AreNotStatic', () => {
    const source = [
      "import type { A } from './a.js';",
      "import { type B } from './b.js';",
      "import pino from 'pino';",
      "export type { C } from './c.js';",
      "const lazy = () => import('./d.js');",
      "import { e } from './e.js';",
    ].join('\n');
    expect(staticValueSpecifiers(source, 'src/x.ts')).toEqual(['./e.js']);
  });

  /** The guard paths are real files, so a rename cannot leave the allowlist stale. */
  it('EntryModule_AllowlistMembers_Exist', () => {
    const missing = [...ALLOWED_CLOSURE].filter((path) => !existsSync(join(REPO_ROOT, path)));
    expect(missing.map((path) => relative(REPO_ROOT, join(REPO_ROOT, path)))).toEqual([]);
  });
});
