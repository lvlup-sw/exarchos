import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanFile,
  scanPaths,
  scanRepoDefaults,
  scanText,
  scanRegistryActions,
  datedRecordTrees,
  type RegistryLoader,
  type RegistryToolLike,
} from './vocabulary-lint.js';
import { ARTIFACT_DIRS } from './bindings/index.js';

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
const ENABLED_CONFIG = {
  invariants: { catalogs: [{ path: INVARIANTS_DOC, tier: 'dev' as const }] },
};

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

// ─── scanText core (DR-5, factored out of scanFileWithKnown) ──────────────
//
// scanText is the in-memory token-scan core the file-path scanners above
// delegate to (`locator` = the file path there — unchanged behavior,
// pinned by the `vocabulary-lint` describe block above, which never calls
// scanText directly). These tests exercise scanText directly with a
// non-file locator, proving it has no file-IO dependency and behaves
// identically to the old inline loop: multi-line text, one finding per
// distinct token per line, known IDs skipped, 1-based line numbers.
describe('scanText (DR-5 core)', () => {
  it('scanText_UnknownToken_IsFlaggedWithLocatorAndLine', () => {
    const findings = scanText(
      'first line is clean\nsecond line cites INV-99 which is unknown',
      'some-locator',
      new Set<string>(),
    );
    expect(findings).toEqual([
      { file: 'some-locator', line: 2, token: 'INV-99', kind: 'unknown-invariant' },
    ]);
  });

  it('scanText_KnownToken_IsNotFlagged', () => {
    const findings = scanText(
      'cites INV-1 which is known',
      'some-locator',
      new Set(['INV-1']),
    );
    expect(findings).toEqual([]);
  });

  it('scanText_RepeatedTokenOnSameLine_DedupsToOneFinding', () => {
    const findings = scanText(
      'INV-99 appears twice on one line: INV-99',
      'some-locator',
      new Set<string>(),
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.token).toBe('INV-99');
  });

  it('scanText_SameTokenDifferentLines_IsOneFindingPerLine', () => {
    const findings = scanText(
      'INV-99 on line one\nINV-99 on line two',
      'some-locator',
      new Set<string>(),
    );
    expect(findings.length).toBe(2);
    // Hoisted rather than `.sort()).toEqual(...)` inline, matching the two
    // other order-normalised assertions in this file. The expected side is a
    // literal, not a second read of the corpus, so this is not the parity
    // shape the DR-30 `@oracle-sources` rule polices.
    const lines = findings.map((f) => f.line).sort();
    expect(lines).toEqual([1, 2]);
  });
});

// ─── scanRegistryActions (DR-4/DR-5) ───────────────────────────────────────
describe('scanRegistryActions (DR-4/DR-5)', () => {
  const fixtureLoader = (tools: readonly RegistryToolLike[]): RegistryLoader =>
    () => tools;

  it('scanRegistryActions_BogusInvToken_IsFlagged', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_orchestrate',
        actions: [
          {
            name: 'do_thing',
            description: 'Does a thing per INV-99 which does not exist.',
          },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.token).toBe('INV-99');
    expect(findings[0]!.kind).toBe('unknown-invariant');
    // Stable locator: registry.ts + tool + action (DR-5).
    expect(findings[0]!.file).toBe('registry.ts#exarchos_orchestrate.do_thing');
  });

  it('scanRegistryActions_ValidInvToken_IsNotFlagged', async () => {
    const loader = fixtureLoader([
      {
        name: 'exarchos_workflow',
        actions: [
          {
            name: 'get',
            description: 'Reads workflow state per INV-1 (event-sourcing integrity).',
          },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('scanRegistryActions_ScansActionNameToo_NotJustDescription', async () => {
    // Open Question in the spec resolved to "scan both name and
    // description" — a bogus token in the `name` field must also surface,
    // not just in `description`.
    const loader = fixtureLoader([
      {
        name: 'exarchos_view',
        actions: [
          // Word-boundary-delimited so TOKEN_RE actually matches (a real
          // snake_case action id would never embed a hyphenated token, but
          // the point is to prove the `name` field is scanned at all).
          { name: 'action-citing-INV-99-in-its-name', description: 'harmless prose' },
        ],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const tokens = findings.map((f) => f.token);
    expect(tokens).toContain('INV-99');
  });

  it('scanRegistryActions_MultipleCompositeTools_AreAllEnumerated', async () => {
    // DR-4: ALL exported composite tools must be scanned, not just one.
    const loader = fixtureLoader([
      {
        name: 'exarchos_workflow',
        actions: [{ name: 'a', description: 'cites INV-101' }],
      },
      {
        name: 'exarchos_event',
        actions: [{ name: 'b', description: 'cites INV-102' }],
      },
      {
        name: 'exarchos_orchestrate',
        actions: [{ name: 'c', description: 'cites INV-103' }],
      },
      {
        name: 'exarchos_view',
        actions: [{ name: 'd', description: 'cites INV-104' }],
      },
    ]);
    const findings = await scanRegistryActions(loader, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    const tokens = findings.map((f) => f.token).sort();
    expect(tokens).toEqual(['INV-101', 'INV-102', 'INV-103', 'INV-104']);
  });

  it('scanRegistryActions_ThrowingLoader_FailsClosed', async () => {
    const throwingLoader: RegistryLoader = () => {
      throw new Error('registry import boom');
    };
    await expect(
      scanRegistryActions(throwingLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow('registry import boom');
  });

  it('scanRegistryActions_RejectingAsyncLoader_FailsClosed', async () => {
    const rejectingLoader: RegistryLoader = () =>
      Promise.reject(new Error('async registry load boom'));
    await expect(
      scanRegistryActions(rejectingLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow('async registry load boom');
  });

  it('scanRegistryActions_MalformedRegistryNotAnArray_FailsClosed', async () => {
    const malformedLoader = (() =>
      ({ notAnArray: true }) as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  it('scanRegistryActions_MalformedToolMissingActions_FailsClosed', async () => {
    const malformedLoader = (() =>
      [{ name: 'exarchos_workflow' }] as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  it('scanRegistryActions_MalformedActionMissingDescription_FailsClosed', async () => {
    const malformedLoader = (() =>
      [
        { name: 'exarchos_workflow', actions: [{ name: 'only_a_name' }] },
      ] as unknown) as RegistryLoader;
    await expect(
      scanRegistryActions(malformedLoader, {
        invariantsDoc: INVARIANTS_DOC,
        config: ENABLED_CONFIG,
      }),
    ).rejects.toThrow();
  });

  it('scanRegistryActions_DefaultLoader_ScansRealRegistryCleanly', async () => {
    // Exercises the default lazy `import()` loader end-to-end against the
    // real, live registry — proving the seam works unmocked, not just with
    // injected fixtures. The live registry's action text must not cite any
    // unknown INV-*/DIM-* token.
    const findings = await scanRegistryActions(undefined, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('scanRegistryActions_SourceHasNoStaticRegistryImportEdge', () => {
    // DR-5: the loader seam must be a dynamic `import()` inside a function
    // body, never a static top-level `import ... from '../registry.js'`
    // declaration — a static edge would parse the ~4k-line registry module
    // at vocabulary-lint's own module-load time, defeating the lazy-load +
    // testable-fail-closed contract.
    const sourcePath = path.join(__dirname, 'vocabulary-lint.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/^\s*import\b[^;]*from\s+['"]\.\.\/registry\.js['"]/m);
    expect(source).toMatch(/import\(\s*['"]\.\.\/registry\.js['"]\s*\)/);
  });
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
    //    the excluded dated-record set, and that set is DISJOINT from the
    //    scanned allowlist — so nothing scanRepoDefaults reads is a dated-record
    //    tree, making the set inert to the scan (vacuous to edit). ──
    const dated = datedRecordTrees(ARTIFACT_DIRS);
    expect(dated).toContain('docs/designs/');
    expect(dated).toContain('docs/plans/');
    for (const scanRoot of SCAN_ROOTS) {
      const scanned = `${scanRoot}/`;
      expect(
        dated,
        `${scanned} must not be a dated-record tree — the scan allowlist and the dated-record set are disjoint`,
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
