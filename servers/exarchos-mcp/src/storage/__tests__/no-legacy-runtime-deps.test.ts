import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

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

// servers/exarchos-mcp/src/storage/__tests__/ → servers/exarchos-mcp/
const mcpPackageJsonPath = resolve(__dirname, '../../../package.json');
// servers/exarchos-mcp/ → repo root
const rootPackageJsonPath = resolve(__dirname, '../../../../../package.json');
// servers/exarchos-mcp/src/storage/__tests__/ → servers/exarchos-mcp/src/
const SRC_DIR = resolve(__dirname, '../../');

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
const BUN_SQLITE_IMPORT_RE = /from\s+['"]bun:sqlite['"]/;

/**
 * Walk the production tree under `src/`, collecting every `.ts` file that:
 *   - is not under any directory named `storage`, `__shims__`, or `__tests__`;
 *   - is not a `.test.ts` or `.d.ts` file.
 *
 * The `storage/` exclusion is the principle: that directory IS the
 * abstraction; everything else must go through it.
 */
function collectProductionTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
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
      if (BUN_SQLITE_IMPORT_RE.test(content)) {
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
});
