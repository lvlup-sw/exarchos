// ─── Every structural directory explains itself ──────────────────────────────
//
// A directory whose purpose lives only in someone's head accumulates whatever
// arrives. The READMEs are the cheapest durable answer to "does this belong
// here?", and this file keeps them from going missing or going empty.
//
// The population is ENUMERATED from the tree, never listed here. A hard-coded
// count is the failure this is written against: a seventh directory could be
// added with no README and a count-based check would still pass, because the
// count it compares against is the one the author updated.
//
// @oracle-sources: live-top-level-directory-listing, ../../tests/architecture/top-level-contract.test.ts

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Directories that carry the repository's structure and therefore owe an
 * explanation. Dot-directories are tooling homes, not structure, and are
 * excluded for the same reason the top-level contract classifies them
 * separately.
 *
 * `documentation/` is deliberately absent: it is the VitePress site awaiting
 * reduction, listed by the top-level contract because it EXISTS rather than
 * because it belongs. Requiring a README would be asking someone to document a
 * directory that is scheduled to stop existing.
 */
const NOT_STRUCTURE = new Set(['node_modules', 'dist', 'documentation', 'binding', 'hooks']);

function structuralDirectories(): string[] {
  return fs
    .readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NOT_STRUCTURE.has(e.name))
    .map((e) => e.name)
    .sort();
}

describe('Readmes_EveryTopLevelDirectory_HasOne', () => {
  const dirs = structuralDirectories();

  it('the enumeration found the tree', () => {
    // Denominator. An empty listing satisfies every per-directory check below
    // by having nothing to check — the exact way this guard would die quietly.
    expect(dirs.length, 'no structural directories enumerated').toBeGreaterThanOrEqual(6);
    // The six DR-1 names, so a directory disappearing is a failure here too and
    // not merely a smaller set that still passes.
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

  it('every README says what does NOT belong, not just what does', () => {
    // The half that does the work. "This directory holds the source" answers
    // nothing a reader could not guess; the boundary is the useful part, and
    // it is what stops the next arrival from landing in the wrong place.
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

  it('rendered/ says in as many words that it is generated', () => {
    // Singled out because the cost of getting this one wrong is silent: an
    // edit here survives review and is reverted by the next build.
    const text = fs.readFileSync(path.join(REPO_ROOT, 'rendered/README.md'), 'utf8');
    expect(text).toMatch(/generated/i);
    expect(text).toMatch(/never edit|not authored|hand edit/i);
  });
});
