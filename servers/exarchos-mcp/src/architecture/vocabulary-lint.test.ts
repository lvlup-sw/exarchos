import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanFile,
  scanPaths,
  scanRepoDefaults,
  DATED_RECORD_TREES,
} from './vocabulary-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, '.exarchos/invariants.md');

/**
 * Pass an explicit `enabled` config so the test fixture is decoupled
 * from the state of the repo's actual `.exarchos.yml`. The Wave B3
 * commit declares the flag in the root file; this constant keeps the
 * tests stable independent of that landing order. See Wave B2 in
 * docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §4.0.
 */
const ENABLED_CONFIG = { invariants: { devCatalog: 'enabled' as const } };

describe('vocabulary-lint', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-lint-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('VocabularyLint_UnknownInvariantReference_Fails', () => {
    const fixture = path.join(tmpDir, 'unknown-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-99 which does not exist.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBeGreaterThan(0);
    const inv99 = findings.find((f) => f.token === 'INV-99');
    expect(inv99).toBeDefined();
    expect(inv99!.kind).toBe('unknown-invariant');
  });

  it('VocabularyLint_KnownInvariantReference_Passes', () => {
    const fixture = path.join(tmpDir, 'known-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-1 which is documented.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('VocabularyLint_MultipleFileScan_AggregatesFindings', () => {
    const subDir = path.join(tmpDir, 'multi');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'a.md'), 'Prose with INV-1 and INV-77.\n');
    // DIM-* tokens are no longer known IDs after the axiom excision (#1477):
    // the token scanner still recognizes the DIM-\d+ *shape*, so any DIM-N
    // reference now surfaces as an unknown-invariant finding.
    fs.writeFileSync(path.join(subDir, 'b.md'), 'Prose with INV-2 and DIM-42.\n');
    const findings = scanPaths([subDir], {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBe(2);
    const tokens = findings.map((f) => f.token).sort();
    expect(tokens).toEqual(['DIM-42', 'INV-77']);
    // Each finding carries file + line.
    for (const f of findings) {
      expect(typeof f.file).toBe('string');
      expect(typeof f.line).toBe('number');
      expect(f.line).toBeGreaterThan(0);
    }
  });

  // ─── Coverage-closure (DR-8) excised (#1477) ──────────────────────────
  //
  // The coverage-closure scan (`scanCoverageClosure`) verified that every
  // `DIM-*` axiom-dimension entry was specialized by an `INV-*` via
  // `axiom_overlap` or explicitly exempted with `coverage: n/a`. The axiom
  // excision removed the DIM-* entries and the `axiom_overlap` field, so the
  // scan and its tests are gone with them. The token scanner (above) still
  // recognizes the `DIM-\d+` shape so a stale DIM-N reference in prose
  // surfaces as an unknown-invariant finding.
});

// ─── DR-18 archival boundary (task 030) ───────────────────────────────────
//
// The wave-1 debloat archival (task 030) moves every superseded dated
// `docs/plans/<date>.md` and `docs/designs/<date>.md` record into an `archive/`
// subtree. This pins the `DATED_RECORD_TREES` / `scanRepoDefaults` boundary and
// proves the constant is correctly LEFT ALONE:
//
//   - `scanRepoDefaults` walks a POSITIVE four-root allowlist
//     (docs/architecture, docs/guides, skills-src, commands) and NEVER reads
//     `DATED_RECORD_TREES`. So archiving `docs/plans` + `docs/designs` (already
//     outside the allowlist, archive subtree included) cannot change the scanned
//     surface — the scan roots are invariant to archival.
//   - Because the allowlist is disjoint from the dated-record trees,
//     `DATED_RECORD_TREES` is INERT to the scan: editing it (e.g. to add an
//     `archive/` path during the move) is a vacuous no-op. That is exactly why
//     the constant must not be touched.
describe('scanRepoDefaults / DATED_RECORD_TREES archival-invariance (DR-18, task 030)', () => {
  // The exact positive allowlist `scanRepoDefaults` scans, mirrored here so the
  // disjointness assertion below locks the live constant against the function.
  const SCAN_ROOTS = [
    'docs/architecture',
    'docs/guides',
    'skills-src',
    'commands',
  ] as const;

  it('VocabularyLint_ScanRoots_UnchangedByArchival', () => {
    // ── Oracle: replicate scanRepoDefaults's allowlist scan over a controlled
    //    tree that also contains the archived dated-record trees. A stale token
    //    lives in EVERY tree; only the four live-surface hits may surface. ──
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-archival-'));
    const seed = (rel: string, token: string) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Each stale INV token is unique so a leak is attributable to its tree.
      fs.writeFileSync(abs, `Prose referencing ${token} which does not exist.\n`);
    };
    // Live surfaces (scanned):
    seed('docs/architecture/a.md', 'INV-9001');
    seed('docs/guides/g.md', 'INV-9002');
    seed('skills-src/s/SKILL.md', 'INV-9003');
    seed('commands/c.md', 'INV-9004');
    // Archived dated-record trees (NOT scanned) — the archival destination and
    // its parent, each seeded to prove neither is ever reached:
    seed('docs/designs/archive/2026-05-30-x.md', 'INV-9100');
    seed('docs/designs/2026-05-30-y.md', 'INV-9101');
    seed('docs/plans/archive/2026-05-30-x.md', 'INV-9102');
    seed('docs/plans/2026-05-30-y.md', 'INV-9103');

    try {
      const findings = scanPaths(
        SCAN_ROOTS.map((r) => path.join(root, r)),
        { invariantsDoc: INVARIANTS_DOC, config: ENABLED_CONFIG },
      );
      const tokens = findings.map((f) => f.token).sort();
      // Exactly the four live-surface tokens — no archived-tree token leaks in.
      expect(tokens).toEqual(['INV-9001', 'INV-9002', 'INV-9003', 'INV-9004']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    // ── Bind to the live constant + function: the archived trees are members of
    //    the excluded DATED_RECORD_TREES set, and that set is DISJOINT from the
    //    scanned allowlist — so nothing scanRepoDefaults reads is a dated-record
    //    tree, making DATED_RECORD_TREES inert to the scan (vacuous to edit). ──
    expect(DATED_RECORD_TREES).toContain('docs/designs/');
    expect(DATED_RECORD_TREES).toContain('docs/plans/');
    for (const scanRoot of SCAN_ROOTS) {
      const scanned = `${scanRoot}/`;
      expect(
        DATED_RECORD_TREES,
        `${scanned} must not be a dated-record tree — the scan allowlist and DATED_RECORD_TREES are disjoint`,
      ).not.toContain(scanned);
    }

    // ── Real repo: scanRepoDefaults surfaces nothing from docs/designs or
    //    docs/plans (archive subtree included), so the physical archival move
    //    cannot alter its findings. ──
    const repoFindings = scanRepoDefaults({
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const fromDatedTrees = repoFindings.filter(
      (f) => f.file.includes('/docs/designs/') || f.file.includes('/docs/plans/'),
    );
    expect(fromDatedTrees).toEqual([]);
  });
});
