import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * Guard rail: better-sqlite3 is a test-only dependency.
 *
 * Task 1.1 introduced a vitest alias shim that maps `bun:sqlite` to
 * `better-sqlite3` so Node-based test runs can exercise the storage
 * backend. Production code imports real `bun:sqlite` under the Bun
 * runtime and never needs `better-sqlite3`. These assertions pin that
 * invariant: better-sqlite3 must live in devDependencies only.
 *
 * T17 (DR-2 of the durable-event-store-substrate plan) extends the
 * guard rail to *imports*: production code outside `storage/` must
 * never reach for `bun:sqlite` directly. Raw `Database` access has to
 * go through the `StorageBackend` abstraction that DR-2 surfaces on
 * `DispatchContext.storage`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// src/storage/__tests__/ → servers/exarchos-mcp/
const mcpPackageJsonPath = resolve(__dirname, '../../../package.json');
// servers/exarchos-mcp/ → repo root
const rootPackageJsonPath = resolve(__dirname, '../../../package.json');
// src/storage/__tests__/ → src/
const SRC_DIR = resolve(__dirname, '../../../src');

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

// ─── Source-tree walker (T17) ───────────────────────────────────────────────

const EXCLUDED_SEGMENTS = new Set(['storage', '__shims__', '__tests__']);
const FORBIDDEN_MODULE_SPECIFIER = 'bun:sqlite';

/**
 * Returns true iff `source` references `bun:sqlite` as a module
 * specifier in ANY of the import/export forms TypeScript supports:
 *
 *   - static value/type imports:     import x from 'bun:sqlite'
 *                                    import { Database } from 'bun:sqlite'
 *                                    import * as db from 'bun:sqlite'
 *                                    import type { … } from 'bun:sqlite'
 *   - side-effect import:            import 'bun:sqlite'
 *   - dynamic import:                import('bun:sqlite')
 *   - re-exports:                    export * from 'bun:sqlite'
 *                                    export { Database } from 'bun:sqlite'
 *
 * Implementation: parses the source with the TypeScript compiler API
 * and walks the AST. This replaces the previous regex
 * `/from\s+['"]bun:sqlite['"]/`, which silently missed side-effect and
 * dynamic forms (T67 / CR #7). Walking the AST also avoids matching
 * the literal string when it appears in a comment or unrelated string
 * literal.
 *
 * The TypeScript dependency is already present (it powers `npm run
 * typecheck`) so this adds no new install surface.
 */
function scanSourceForBunSqlite(source: string): boolean {
  const sf = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // import x from '…' / import { … } from '…' / import '…' / import type … from '…'
    if (ts.isImportDeclaration(node)) {
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === FORBIDDEN_MODULE_SPECIFIER
      ) {
        found = true;
        return;
      }
    }
    // export * from '…' / export { … } from '…'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === FORBIDDEN_MODULE_SPECIFIER
      ) {
        found = true;
        return;
      }
    }
    // import('…') — `import` keyword as call expression callee
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first) && first.text === FORBIDDEN_MODULE_SPECIFIER) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Minimal filesystem surface the walker uses. Injected so T68 fault
 * fixtures can simulate permission-denied / I/O failures without
 * touching the real filesystem.
 */
type WalkerFs = {
  readdirSync: (dir: string) => string[];
  statSync: (full: string) => { isDirectory: () => boolean; isFile: () => boolean };
};

const REAL_WALKER_FS: WalkerFs = { readdirSync, statSync };

/**
 * Walk the production tree under `src/`, collecting every `.ts` file that:
 *   - is not under any directory named `storage`, `__shims__`, or `__tests__`;
 *   - is not a `.test.ts` or `.d.ts` file.
 *
 * The `storage/` exclusion is the principle: that directory IS the
 * abstraction; everything else must go through it.
 */
function collectProductionTsFiles(rootDir: string, fs: WalkerFs = REAL_WALKER_FS): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      // T68 (CR #8 / DIM-2): never silently swallow walk failures.
      // A permission-denied or transient I/O error here would cause
      // the walker to return a partial list, and the INV-2 enforcement
      // test would then green-light a walk that never visited half the
      // tree. Surface the underlying error with path context so CI
      // fails loudly instead of false-negative-passing.
      throw new Error(
        `walker readdirSync failed at ${dir}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = fs.statSync(full);
      } catch (err) {
        // T68: same rationale as above — re-throw with path context.
        throw new Error(
          `walker statSync failed at ${full}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (st.isDirectory()) {
        if (EXCLUDED_SEGMENTS.has(entry)) continue;
        stack.push(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.test.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  }
  return out;
}

describe('no legacy runtime deps', () => {
  it('PackageJson_RuntimeDependencies_ExcludesBetterSqlite3', () => {
    const pkg = readPackageJson(mcpPackageJsonPath);
    expect(pkg.dependencies?.['better-sqlite3']).toBeUndefined();
  });

  it('PackageJson_DevDependencies_IncludesBetterSqlite3', () => {
    // Deliberate test-only retention: the bun:sqlite alias shim
    // imports better-sqlite3 when vitest resolves `bun:sqlite`.
    const pkg = readPackageJson(mcpPackageJsonPath);
    expect(pkg.devDependencies?.['better-sqlite3']).toBeDefined();
  });

  it('RootPackageJson_Dependencies_ExcludesBetterSqlite3', () => {
    // Belt-and-suspenders: the root installer has no runtime sqlite
    // dependency and must stay that way.
    const pkg = readPackageJson(rootPackageJsonPath);
    expect(pkg.dependencies?.['better-sqlite3']).toBeUndefined();
  });

  // ─── T17 (DR-2) — no ambient bun:sqlite outside storage/ ────────────────
  //
  // Strictness-tightening: at the time T17 was authored the production
  // tree already had no ambient `bun:sqlite` imports outside `storage/`
  // (T08–T10 cleanup had already landed). This test pins the
  // invariant so a future regression — e.g. a CLI command or
  // composite handler reaching for raw `Database` — fails CI rather
  // than slipping into release with the abstraction silently bypassed.
  //
  // Excludes:
  //   - `storage/`     — the home of the abstraction itself
  //   - `__shims__/`   — vitest alias targets (test-only)
  //   - `__tests__/`   — test fixtures
  //   - `*.test.ts`    — co-located tests
  //   - `*.d.ts`       — type-only declarations (e.g. `bun-sqlite.d.ts`)
  it('NoLegacyRuntimeDeps_ProductionCode_NoBunSqliteImportsOutsideStorage', () => {
    const productionFiles = collectProductionTsFiles(SRC_DIR);
    // Sanity: the walker must actually find files. If this is ever 0,
    // either the path resolution above broke or the exclusion list
    // accidentally swallowed everything.
    expect(productionFiles.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of productionFiles) {
      const content = readFileSync(file, 'utf-8');
      if (scanSourceForBunSqlite(content)) {
        offenders.push(file.split(`${sep}src${sep}`).pop() ?? file);
      }
    }
    expect(
      offenders,
      `Production code outside storage/ must access SQLite through the ` +
        `StorageBackend abstraction surfaced on DispatchContext.storage. ` +
        `Found bun:sqlite imports in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  // ─── T67 (CR #7) — scanner must catch ALL bun:sqlite import forms ───────
  //
  // The original regex `/from\s+['"]bun:sqlite['"]/` only matches
  // `import x from 'bun:sqlite'` style. CI gate had loopholes for:
  //   - side-effect imports:  import 'bun:sqlite'
  //   - dynamic imports:      import('bun:sqlite')
  //   - re-exports:           export * from 'bun:sqlite'
  //
  // These fixtures exercise every form against the active scanner.
  // A regex-only scanner will fail on the side-effect, dynamic, and
  // re-export fixtures — proving the loophole. The AST-based scanner
  // (T67 GREEN) catches all of them.
  describe('T67 scanner-form coverage', () => {
    const FIXTURES: ReadonlyArray<{ name: string; src: string }> = [
      {
        name: 'default import',
        src: `import Database from 'bun:sqlite';\nconst db = new Database();\n`,
      },
      {
        name: 'named import',
        src: `import { Database } from 'bun:sqlite';\nnew Database();\n`,
      },
      {
        name: 'side-effect import',
        src: `import 'bun:sqlite';\n`,
      },
      {
        name: 'dynamic import',
        src: `const m = await import('bun:sqlite');\nconsole.log(m);\n`,
      },
      {
        name: 're-export all',
        src: `export * from 'bun:sqlite';\n`,
      },
      {
        name: 'named re-export',
        src: `export { Database } from 'bun:sqlite';\n`,
      },
    ];

    const NEGATIVE_FIXTURES: ReadonlyArray<{ name: string; src: string }> = [
      {
        name: 'unrelated module import',
        src: `import { z } from 'zod';\nz.string();\n`,
      },
      {
        name: 'string literal containing the spec but not an import',
        // The literal appears but is never the module specifier of an
        // import/export/dynamic-import call, so it must not match.
        src: `const note = "see also bun:sqlite docs";\nconsole.log(note);\n`,
      },
    ];

    for (const f of FIXTURES) {
      it(`detects bun:sqlite in ${f.name}`, () => {
        expect(scanSourceForBunSqlite(f.src)).toBe(true);
      });
    }

    for (const f of NEGATIVE_FIXTURES) {
      it(`does not flag ${f.name}`, () => {
        expect(scanSourceForBunSqlite(f.src)).toBe(false);
      });
    }
  });

  // ─── T68 (CR #8) — walker must surface I/O errors loudly ────────────────
  //
  // The original walker wrapped both `readdirSync` and `statSync` in
  // bare `try { … } catch {}` blocks that silently `continue`d on
  // any error. A permission-denied directory or transient I/O fault
  // mid-walk would cause the walker to skip the affected subtree and
  // return a partial list. The INV-2 enforcement test would then
  // happily green-light the missing-coverage walk — the worst kind
  // of false negative, because the gate looks like it's protecting
  // the invariant when it's actually blind to half the tree.
  //
  // DIM-2 (observability) requires test infra to fail loudly when
  // its assumptions are violated. These fixtures inject an fs that
  // throws to prove the walker no longer swallows errors.
  describe('T68 walker fault surfaces', () => {
    it('readdirSync_PermissionDenied_ThrowsWithPathContext', () => {
      const failing = '/no-such/permission-denied-root';
      const fs: WalkerFs = {
        readdirSync: (dir: string): string[] => {
          const err = new Error('EACCES: permission denied') as Error & { code?: string };
          err.code = 'EACCES';
          // Encode the offending path so the assertion can pin it.
          throw Object.assign(err, { path: dir });
        },
        statSync: () => ({ isDirectory: () => false, isFile: () => false }),
      };
      expect(() => collectProductionTsFiles(failing, fs)).toThrowError(
        new RegExp(failing.replace(/\//g, '\\/')),
      );
    });

    it('statSync_PermissionDenied_ThrowsWithPathContext', () => {
      // First readdir returns one entry; statSync on that entry blows up.
      const root = '/synthetic/root';
      const child = 'leaf.ts';
      const fs: WalkerFs = {
        readdirSync: (dir: string): string[] => {
          if (dir === root) return [child];
          return [];
        },
        statSync: (full: string) => {
          const err = new Error('EACCES: permission denied') as Error & { code?: string };
          err.code = 'EACCES';
          throw Object.assign(err, { path: full });
        },
      };
      const expectedPath = join(root, child);
      expect(() => collectProductionTsFiles(root, fs)).toThrowError(
        new RegExp(expectedPath.replace(/[\\/]/g, '[\\\\/]')),
      );
    });
  });
});
