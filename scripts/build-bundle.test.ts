/**
 * Assertion-based grep checks over `scripts/build-bundle.ts` that fail the
 * test run if any legacy platform-variant native-addon wiring is still
 * present.
 *
 * Context (v29 install rewrite, task 1.3): Task 1.1 swapped persistence to
 * `bun:sqlite`, which has no native addon. Task 1.2 narrowed
 * `better-sqlite3` to a devDependency. That leaves the bundle script's
 * `--external better-sqlite3 / bindings / file-uri-to-path` flags and the
 * `dist/node_modules/**` copy loop as dead code. These tests pin the
 * removal so the dead code cannot reappear.
 *
 * Scope boundary: `scripts/build-bundle.ts` and `dist/exarchos.js` are
 * still emitted — the legacy JS-bundle plugin path survives until task
 * 3.6. The assertions below target only the variant-copy logic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE_SCRIPT = join(REPO_ROOT, 'scripts', 'build-bundle.ts');

function readBundleScript(): string {
  return readFileSync(BUNDLE_SCRIPT, 'utf-8');
}

describe('scripts/build-bundle.ts', () => {
  it('BuildBundle_HasNoBetterSqlite3References', () => {
    const source = readBundleScript();
    expect(source).not.toMatch(/better-sqlite3/);
  });

  it('BuildBundle_HasNoBindingsPackageCopy', () => {
    const source = readBundleScript();
    // Match only the package-name form in string literals, not an
    // incidental type/identifier named `bindings`.
    expect(source).not.toMatch(/['"]bindings['"]/);
  });

  it('BuildBundle_HasNoFileUriToPathPackageCopy', () => {
    const source = readBundleScript();
    expect(source).not.toMatch(/file-uri-to-path/);
  });

  it('BuildBundle_HasNoNodeModulesCopyLogic', () => {
    const source = readBundleScript();
    expect(source).not.toMatch(/dist\/node_modules/);
    expect(source).not.toMatch(/node_modules\/better-sqlite3\/build/);
  });
});
