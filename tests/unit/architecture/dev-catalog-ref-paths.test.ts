/**
 * Guard for the `references:` paths of the live invariant catalog (`.exarchos/invariants.md`).
 * Each path must resolve on the real filesystem, not in a fixture.
 * The guard skips a pure `#anchor` entry and checks the path part of a `path#anchor` entry.
 * `dev-catalog-content.test.ts` reads the frontmatter content only, so a path that does not exist passes there.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadInvariants } from '../../../src/architecture/invariants-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

/** Removes a trailing `#anchor` fragment. A reference that is only an anchor becomes the empty string. */
function pathPart(ref: string): string {
  const hashIdx = ref.indexOf('#');
  return hashIdx === -1 ? ref : ref.slice(0, hashIdx);
}

describe('dev-catalog reference paths — #1478 existence guard', () => {
  /**
   * An `<owner>/<repo>:<path>` reference names a document in a different repository, so this test cannot resolve it.
   * For that form, the test only checks that a path comes after the colon.
   */
  it('devCatalog_everyReferencePathExistsOnDisk', () => {
    const entries = loadInvariants(
      INVARIANTS_DOC,
      { scope: 'all' },
      ENABLED_CONFIG,
    );
    expect(entries.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const entry of entries) {
      for (const ref of entry.references) {
        const p = pathPart(ref).trim();
        if (p === '') continue;
        if (/^[\w.-]+\/[\w.-]+:/.test(p)) {
          const [, target] = p.split(':');
          expect(target?.length ?? 0, `${entry.id} → ${ref} names a repo but no path`).toBeGreaterThan(0);
          continue;
        }
        const abs = path.resolve(REPO_ROOT, p);
        if (!fs.existsSync(abs)) {
          missing.push(`${entry.id} → ${ref}`);
        }
      }
    }

    expect(
      missing,
      `catalog references that do not resolve on disk:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * A reference to a TypeScript module must name a module that declares something.
   * After a decomposition, the old path can stay as a re-export barrel that resolves but states nothing.
   * The count assertion requires more than five TypeScript references, so the barrel check cannot pass with nothing to check.
   */
  it('InvariantCatalog_AfterHotspotDecomposition_StillResolves', () => {
    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);

    const tsRefs = entries.flatMap((entry) =>
      entry.references
        .map((ref) => ({ id: entry.id, p: pathPart(ref).trim() }))
        .filter(({ p }) => p.endsWith('.ts')),
    );

    expect(tsRefs.length, 'the catalog cites no TypeScript module').toBeGreaterThan(5);

    const DECLARES = /^\s*(export\s+)?(async\s+)?(const|let|function|class|interface|type|enum)\s/m;

    const barrels = tsRefs
      .filter(({ p }) => !/^[\w.-]+\/[\w.-]+:/.test(p))
      .filter(({ p }) => {
        const abs = path.resolve(REPO_ROOT, p);
        if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return false;
        return !DECLARES.test(fs.readFileSync(abs, 'utf8'));
      })
      .map(({ id, p }) => `${id} → ${p}`);

    expect(
      barrels,
      'catalog references pointing at a pure re-export barrel. The path resolves, but a reader ' +
        'following it finds no declaration. Cite the module that DECLARES the thing the ' +
        'invariant constrains:\n  ' + barrels.join('\n  '),
    ).toEqual([]);
  });
});
