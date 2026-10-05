// Each structural directory explains itself.
//
// A directory with no written purpose collects whatever arrives. Each README
// states what belongs in its directory. This file fails when a README is
// missing or states no boundary.
//
// The suite reads the population from the tree. A hard-coded count is not
// sufficient: a new directory with no README passes when its author also
// updates the count.
//
// @oracle-sources: live-top-level-directory-listing, ../../tests/architecture/top-level-contract.test.ts

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Top-level directories that are not repository structure and need no README.
 * An external contract fixes the paths of `binding/` and `hooks/`, so their
 * location is not a choice of this repository. `structuralDirectories` also
 * skips dot-directories, which hold tooling.
 */
const NOT_STRUCTURE = new Set(['node_modules', 'dist', 'binding', 'hooks']);

function structuralDirectories(): string[] {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NOT_STRUCTURE.has(e.name))
    .map((e) => e.name)
    .sort();
}

describe('Readmes_EveryTopLevelDirectory_HasOne', () => {
  const dirs = structuralDirectories();

  /**
   * Denominator check. An empty listing passes each per-directory test below.
   * The six required names make a deleted directory fail here, because a
   * smaller set still passes the other tests.
   */
  it('the enumeration found the tree', () => {
    expect(dirs.length, 'no structural directories enumerated').toBeGreaterThanOrEqual(6);
    for (const required of ['content', 'docs', 'rendered', 'src', 'tests', 'tools']) {
      expect(dirs, `${required}/ is missing from the tree`).toContain(required);
    }
  });

  it('every structural directory has a README', () => {
    const missing = dirs.filter((d) => !fs.existsSync(path.join(REPO_ROOT, d, 'README.md')));
    expect(
      missing,
      'These directories carry repository structure but do not say what belongs in them. ' +
        'A seventh directory cannot be added without one.',
    ).toEqual([]);
  });

  /**
   * A reader can guess what a directory holds from its name. The boundary is
   * the useful part, because it keeps a new file out of the wrong directory.
   */
  it('every README says what does NOT belong, not just what does', () => {
    const thin: string[] = [];
    for (const dir of dirs) {
      const file = path.join(REPO_ROOT, dir, 'README.md');
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!/does not|do not|never|must not/i.test(text)) thin.push(`${dir}/README.md`);
    }
    expect(
      thin,
      'These READMEs state what a directory holds but never what it excludes. State the ' +
        'boundary — that is the part a reader cannot infer from the directory name.',
    ).toEqual([]);
  });

  /** An edit under `rendered/` passes review, and the next build reverts it silently. */
  it('rendered/ says in as many words that it is generated', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'rendered/README.md'), 'utf8');
    expect(text).toMatch(/generated/i);
    expect(text).toMatch(/never edit|not authored|hand edit/i);
  });
});
