// ─── Dev-catalog reference-path existence guard (issue #1478) ────────────────
//
// `dev-catalog-content.test.ts` checks frontmatter *content* only, which is why
// three `references:` paths rotted silently (INV-7/8/13 → moved/renamed source,
// INV-9 → removed `hsm/` directory). This guard walks EVERY `references:` entry
// in the LIVE catalog (`.exarchos/invariants.md`) and asserts each
// resolves to a real path on disk (DIM-4: real catalog vs real filesystem, not a
// fixture). Pure doc-anchor fragments (`#...`) are skipped; a `path#anchor` entry
// has its path part checked.
// ────────────────────────────────────────────────────────────────────────────

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

/**
 * Strip a trailing `#anchor` fragment so a `path#section` reference checks only
 * the path component. A reference that is *only* an anchor (`#section`, no path)
 * collapses to the empty string and is skipped by the caller.
 */
function pathPart(ref: string): string {
  const hashIdx = ref.indexOf('#');
  return hashIdx === -1 ? ref : ref.slice(0, hashIdx);
}

describe('dev-catalog reference paths — #1478 existence guard', () => {
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
        if (p === '') continue; // pure doc-anchor (`#section`) — nothing to resolve
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

  it('InvariantCatalog_AfterHotspotDecomposition_StillResolves', () => {
    // Existence is the weaker half. When a module is decomposed, the published
    // path survives as a re-export barrel, so every reference to it keeps
    // resolving while pointing at a file that no longer states anything. A
    // reader following the citation lands on a list of `export … from`.
    //
    // So a reference to a TypeScript module must name one that DECLARES
    // something. This is what makes the catalog survive a decomposition
    // honestly rather than merely quietly.
    const entries = loadInvariants(INVARIANTS_DOC, { scope: 'all' }, ENABLED_CONFIG);

    const tsRefs = entries.flatMap((entry) =>
      entry.references
        .map((ref) => ({ id: entry.id, p: pathPart(ref).trim() }))
        .filter(({ p }) => p.endsWith('.ts')),
    );

    // Denominator: a catalog citing no source at all would pass the filter
    // below without checking anything.
    expect(tsRefs.length, 'the catalog cites no TypeScript module').toBeGreaterThan(5);

    const DECLARES = /^\s*(export\s+)?(async\s+)?(const|let|function|class|interface|type|enum)\s/m;

    const barrels = tsRefs
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
