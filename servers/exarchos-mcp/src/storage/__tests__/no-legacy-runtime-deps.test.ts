import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Guard rail: better-sqlite3 is a test-only dependency.
 *
 * Task 1.1 introduced a vitest alias shim that maps `bun:sqlite` to
 * `better-sqlite3` so Node-based test runs can exercise the storage
 * backend. Production code imports real `bun:sqlite` under the Bun
 * runtime and never needs `better-sqlite3`. These assertions pin that
 * invariant: better-sqlite3 must live in devDependencies only.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// servers/exarchos-mcp/src/storage/__tests__/ → servers/exarchos-mcp/
const mcpPackageJsonPath = resolve(__dirname, '../../../package.json');
// servers/exarchos-mcp/ → repo root
const rootPackageJsonPath = resolve(__dirname, '../../../../../package.json');

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as PackageJson;
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
});
