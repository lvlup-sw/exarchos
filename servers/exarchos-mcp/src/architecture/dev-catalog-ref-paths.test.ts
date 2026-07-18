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

import { loadInvariants } from './invariants-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');
const ENABLED_CONFIG = {
  invariants: { devCatalog: 'enabled' as const },
  ownership: { firstParty: [] as string[] },
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
});
