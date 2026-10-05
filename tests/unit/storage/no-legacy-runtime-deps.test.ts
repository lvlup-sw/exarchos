/**
 * Guards for the SQLite dependency boundary.
 *
 * `better-sqlite3` is a test-only dependency. A vitest alias maps `bun:sqlite` to
 * a shim over it, so that test runs under Node can use the storage backend.
 * Production code runs under Bun and imports `bun:sqlite`, so `better-sqlite3`
 * must stay in `devDependencies`.
 *
 * Production code outside `storage/` must not import `bun:sqlite`. It must reach
 * the database through the `StorageBackend` abstraction.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolves to the root `package.json`, the same file as `rootPackageJsonPath`. */
const mcpPackageJsonPath = resolve(__dirname, '../../../package.json');
const rootPackageJsonPath = resolve(__dirname, '../../../package.json');
const SRC_DIR = resolve(__dirname, '../../../src');

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

const EXCLUDED_SEGMENTS = new Set(['storage', '__shims__', '__tests__']);
const FORBIDDEN_MODULE_SPECIFIER = 'bun:sqlite';

/**
 * Returns true when `source` uses `bun:sqlite` as a module specifier in a static
 * import, a side-effect import, a dynamic `import()`, or a re-export.
 *
 * It walks the TypeScript AST. A regex on `from 'bun:sqlite'` misses the
 * side-effect and dynamic forms. Such a regex also matches the text inside a
 * comment or an unrelated string.
 */
function scanSourceForBunSqlite(source: string): boolean {
  const sf = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === FORBIDDEN_MODULE_SPECIFIER
      ) {
        found = true;
        return;
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === FORBIDDEN_MODULE_SPECIFIER
      ) {
        found = true;
        return;
      }
    }
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

/** The filesystem calls of the walker. A test injects a version that throws to simulate an I/O error. */
type WalkerFs = {
  readdirSync: (dir: string) => string[];
  statSync: (full: string) => { isDirectory: () => boolean; isFile: () => boolean };
};

const REAL_WALKER_FS: WalkerFs = { readdirSync, statSync };

/**
 * Collects each production `.ts` file under `rootDir`. It skips directories named
 * `storage`, `__shims__` or `__tests__`, and files that end in `.test.ts` or
 * `.d.ts`. The `storage` directory is the abstraction, and all other code must
 * go through it.
 *
 * A `readdirSync` or `statSync` error is thrown again with the path. A swallowed
 * error gives a partial list, and the import guard then passes for a tree that
 * it did not fully scan.
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

  /** The alias shim for `bun:sqlite` imports `better-sqlite3` under vitest. */
  it('PackageJson_DevDependencies_IncludesBetterSqlite3', () => {
    const pkg = readPackageJson(mcpPackageJsonPath);
    expect(pkg.devDependencies?.['better-sqlite3']).toBeDefined();
  });

  it('RootPackageJson_Dependencies_ExcludesBetterSqlite3', () => {
    const pkg = readPackageJson(rootPackageJsonPath);
    expect(pkg.dependencies?.['better-sqlite3']).toBeUndefined();
  });

  /**
   * The `.gitignore` file ignores declaration files under `src`. This ambient
   * file is authored, so it needs the exception. Without the exception, `tsc` on
   * a fresh clone cannot resolve `bun:sqlite`.
   */
  it('BunSqliteAmbientDeclaration_IsAuthoredAndTracked', () => {
    const shim = join(SRC_DIR, 'storage', '__shims__', 'bun-sqlite.d.ts');
    expect(existsSync(shim)).toBe(true);
    const gitignore = readFileSync(resolve(__dirname, '../../../.gitignore'), 'utf8');
    expect(gitignore).toMatch(/!src\/storage\/__shims__\/bun-sqlite\.d\.ts/);
  });

  /**
   * A `bun:sqlite` import outside `storage/` bypasses the `StorageBackend`
   * abstraction. The file count check proves that the walker found the tree. A
   * wrong path or an exclusion that is too wide gives no files and a false pass.
   */
  it('NoLegacyRuntimeDeps_ProductionCode_NoBunSqliteImportsOutsideStorage', () => {
    const productionFiles = collectProductionTsFiles(SRC_DIR);
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

  /** The scanner must find `bun:sqlite` in each import and export form, and only as a module specifier. */
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

  /** The walker must throw on a filesystem error, with the path in the message. */
  describe('T68 walker fault surfaces', () => {
    it('readdirSync_PermissionDenied_ThrowsWithPathContext', () => {
      const failing = '/no-such/permission-denied-root';
      const fs: WalkerFs = {
        readdirSync: (dir: string): string[] => {
          const err = new Error('EACCES: permission denied') as Error & { code?: string };
          err.code = 'EACCES';
          throw Object.assign(err, { path: dir });
        },
        statSync: () => ({ isDirectory: () => false, isFile: () => false }),
      };
      expect(() => collectProductionTsFiles(failing, fs)).toThrowError(
        new RegExp(failing.replace(/\//g, '\\/')),
      );
    });

    it('statSync_PermissionDenied_ThrowsWithPathContext', () => {
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
