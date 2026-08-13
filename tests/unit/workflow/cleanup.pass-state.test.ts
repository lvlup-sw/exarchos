// ─── DR-8 — the cleanup pass-state fix is retired ────────────────────────────
//
// ## Characterization (captured against the pre-DR-8 `cleanup.ts`)
//
// `handleCleanup` used to run, immediately before the guarded transition that
// evaluates `guards.mergeVerified`:
//
//     for (const [, value] of Object.entries(reviews)) {
//       ... entry.status = 'approved';           // and nested sub-reviews
//     }
//     mutableState._cleanup = { mergeVerified: true };
//
// Measured on the real handler with
//   reviews = { 't1': { status: 'needs_fixes' },
//               't2': { specReview: { status: 'fail' } } }
// and NO merge artifact anywhere in state:
//   • result.success ............. true
//   • persisted phase ............ 'completed'
//   • persisted t1.status ........ 'approved'   (rewritten)
//   • persisted t2.specReview .... 'approved'   (rewritten)
//
// The guard could not fail: production code wrote the guard's own inputs and
// then asked the guard for permission. That is the `pass-state-fix` class
// `retirement/retirement-safety.ts` declares as an `AuthorityKind`.
//
// ## What changed
//
//   1. The force-approval loop is gone. `state.reviews` is READ-ONLY evidence.
//   2. `_cleanup.mergeVerified` is no longer stamped `true`; it is the verdict
//      of `collectCleanupEvidence`, which requires
//        (a) every review status that exists to already read 'approved', and
//        (b) a typed merge artifact reference (synthesis.prUrl / artifacts.pr /
//            synthesis.mergedBranches).
//      Absent evidence ⇒ `mergeVerified: false` ⇒ the guarded primitive REJECTS
//      the transition. Cleanup fails honestly instead of manufacturing a pass.
//   3. The `state.patched` backfill no longer carries `reviews` — there is no
//      review mutation left to patch.
//
// ## Why the structural assertion below exists
//
// Behavioural tests prove the fix is gone today; they do not stop it coming
// back through a different line of code. `RETIRED_AUTHORITIES` in
// `retirement/retirement-safety.ts` carries the forbidden source patterns and
// `scanRetiredAuthorityReintroduction` runs them over the REAL production tree
// (tests excluded), so a reintroduction goes red mechanically.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleCleanup, collectCleanupEvidence } from '../../../src/workflow/cleanup.js';
import { handleInit } from '../../../src/workflow/tools.js';
import {
  RETIRED_AUTHORITIES,
  AUTHORITY_KINDS,
  scanRetiredAuthorityReintroduction,
  type SourceModule,
} from '../../../src/workflow/retirement/retirement-safety.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

// ─── Real production-source loader (mirrors retirement-safety.test.ts) ───────

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '../../../src'); // …/src

const TEST_PATH_RE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE =
  /(^|\/)(__tests__|__fixtures__|test-fixtures|test-helpers|evals)(\/|$)/;

function isTestPath(rel: string): boolean {
  return TEST_PATH_RE.test(rel) || TEST_DIR_RE.test(rel);
}

function collectSourceModules(root: string): readonly SourceModule[] {
  const modules: SourceModule[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!statSync(full).isFile()) continue;
      if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
      const rel = relative(root, full).split(sep).join('/');
      modules.push({ path: rel, content: readFileSync(full, 'utf8'), isTest: isTestPath(rel) });
    }
  };
  walk(root);
  return modules;
}

const REAL_MODULES = collectSourceModules(SRC_ROOT);

// ─── Behavioural fixtures ────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-cleanup-passstate-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

async function readRawState(featureId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(tmpDir, `${featureId}.state.json`), 'utf-8'));
}

async function writeRawState(
  featureId: string,
  state: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, `${featureId}.state.json`),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

describe('DR-8 — cleanup satisfies its guard by evidence', () => {
  it('Cleanup_UnapprovedReviews_DoesNotForceApprove', async () => {
    // Arrange — the EXACT characterized fixture, plus a real merge artifact
    // ALREADY IN STATE (T-12: caller-supplied prUrl is post-guard metadata, not
    // evidence) so the ONLY missing evidence is the review approvals.
    await handleInit({ featureId: 'ps-unapproved', workflowType: 'feature' }, tmpDir, null);
    const raw = await readRawState('ps-unapproved');
    raw.phase = 'review';
    raw.reviews = {
      't1': { status: 'needs_fixes' },
      't2': { specReview: { status: 'fail' }, qualityReview: { status: 'approved' } },
    };
    raw.synthesis = {
      ...(raw.synthesis as Record<string, unknown>),
      prUrl: 'https://github.com/test/pr/7',
    };
    await writeRawState('ps-unapproved', raw);

    // Act
    const result = await handleCleanup(
      {
        featureId: 'ps-unapproved',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/7',
        mergedBranches: ['feature/t1'],
      },
      tmpDir,
      null,
    );

    // Assert — the guard FAILS on the evidence …
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('reviews are not approved');
    expect(result.error?.message).toContain('t1');
    expect(result.error?.message).toContain('t2.specReview');

    // … and NOTHING was rewritten. This is the characterized behaviour inverted.
    const after = await readRawState('ps-unapproved');
    const reviews = after.reviews as Record<string, Record<string, unknown>>;
    expect(reviews['t1'].status).toBe('needs_fixes');
    expect((reviews['t2'].specReview as Record<string, unknown>).status).toBe('fail');
    expect(after.phase).toBe('review');
    expect(after._cleanup).toBeUndefined();
  });

  it('Cleanup_MergeUnverified_FailsGuardByEvidence', async () => {
    // Arrange — reviews are genuinely approved, but NO merge was ever recorded:
    // no synthesis.prUrl, no artifacts.pr, no mergedBranches, and the caller
    // supplies none. The caller's `mergeVerified: true` is an assertion, not
    // evidence, and must no longer be enough on its own.
    await handleInit({ featureId: 'ps-nomerge', workflowType: 'feature' }, tmpDir, null);
    const raw = await readRawState('ps-nomerge');
    raw.phase = 'review';
    raw.reviews = { 't1': { status: 'approved' } };
    await writeRawState('ps-nomerge', raw);

    // Act
    const result = await handleCleanup(
      { featureId: 'ps-nomerge', mergeVerified: true },
      tmpDir,
      null,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('no merge artifact reference recorded');

    const after = await readRawState('ps-nomerge');
    expect(after.phase).toBe('review');
  });

  it('Cleanup_CallerMintedPrUrlOnly_FailsGuardByEvidence', async () => {
    // T-12 / DR-8 — the complement of Cleanup_MergeUnverified_FailsGuardByEvidence:
    // reviews are genuinely approved and the CALLER supplies a prUrl, but NO
    // merge record pre-exists anywhere in state. Before this fix, cleanup
    // backfilled `synthesis.prUrl` / `artifacts.pr` from the input and then
    // read exactly those fields back as the merge-artifact evidence — a
    // caller-minted `cleanup({ mergeVerified: true, prUrl: 'anything' })`
    // satisfied the merge arm with an unverified same-call assertion. The
    // evidence must now be collected from the PRE-backfill state, so this call
    // fails the guard.
    await handleInit({ featureId: 'ps-caller-minted', workflowType: 'feature' }, tmpDir, null);
    const raw = await readRawState('ps-caller-minted');
    raw.phase = 'review';
    raw.reviews = { 't1': { status: 'approved' } };
    await writeRawState('ps-caller-minted', raw);

    const result = await handleCleanup(
      {
        featureId: 'ps-caller-minted',
        mergeVerified: true,
        prUrl: 'https://github.com/attacker/pr/999',
        mergedBranches: ['feature/anything'],
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('no merge artifact reference recorded');

    // Nothing was persisted: not the phase, and not the caller-minted metadata
    // (init leaves both references null; they must NOT hold the input values).
    const after = await readRawState('ps-caller-minted');
    expect(after.phase).toBe('review');
    expect((after.synthesis as Record<string, unknown> | undefined)?.prUrl ?? null).toBeNull();
    expect((after.artifacts as Record<string, unknown> | undefined)?.pr ?? null).toBeNull();
  });

  it('Cleanup_RealEvidence_SatisfiesGuardWithoutRewritingAnything', async () => {
    // The retirement must not be a blanket denial: with REAL evidence present,
    // cleanup still completes — and still leaves the reviews exactly as it
    // found them.
    await handleInit({ featureId: 'ps-evidence', workflowType: 'feature' }, tmpDir, null);
    const raw = await readRawState('ps-evidence');
    raw.phase = 'review';
    raw.reviews = {
      't1': { status: 'approved' },
      't2': { specReview: { status: 'approved' } },
    };
    raw.synthesis = {
      ...(raw.synthesis as Record<string, unknown>),
      prUrl: 'https://github.com/test/pr/11',
    };
    await writeRawState('ps-evidence', raw);

    const result = await handleCleanup(
      { featureId: 'ps-evidence', mergeVerified: true },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const after = await readRawState('ps-evidence');
    expect(after.phase).toBe('completed');
    const reviews = after.reviews as Record<string, Record<string, unknown>>;
    expect(reviews['t1'].status).toBe('approved');
    expect((reviews['t2'].specReview as Record<string, unknown>).status).toBe('approved');
  });

  it('CollectCleanupEvidence_NeverMutatesTheStateItReads', () => {
    // The collector replaced a mutating loop; prove it is read-only.
    const state = {
      reviews: { 't1': { status: 'needs_fixes' }, 't2': { specReview: { status: 'fail' } } },
      synthesis: {},
      artifacts: {},
    };
    const before = JSON.stringify(state);

    const evidence = collectCleanupEvidence(state as unknown as Record<string, unknown>);

    expect(JSON.stringify(state)).toBe(before);
    expect(evidence.verified).toBe(false);
    expect(evidence.unapprovedReviews).toEqual(['t1', 't2.specReview']);
    expect(evidence.mergeArtifact).toBeNull();
  });

  it('CollectCleanupEvidence_BlankArtifactReference_IsNotEvidence', () => {
    // A whitespace-only PR reference is not a typed artifact reference (DR-5).
    const evidence = collectCleanupEvidence({
      synthesis: { prUrl: '   ', mergedBranches: [] },
      artifacts: { pr: '' },
    });
    expect(evidence.verified).toBe(false);
    expect(evidence.mergeArtifact).toBeNull();

    const withRef = collectCleanupEvidence({
      synthesis: { mergedBranches: ['  feature/x  '] },
    });
    expect(withRef.verified).toBe(true);
    expect(withRef.mergeArtifact).toBe('feature/x');
  });
});

// ─── The structural criterion ────────────────────────────────────────────────

describe('DR-8 — no production path writes the guard inputs', () => {
  it('PassStateFix_NoProductionSourceWritesReviewStatusOrMergeVerified', () => {
    // Sanity: the scan is actually looking at real production modules.
    expect(REAL_MODULES.some((m) => m.path === 'workflow/cleanup.ts' && !m.isTest)).toBe(true);
    expect(REAL_MODULES.filter((m) => !m.isTest).length).toBeGreaterThan(50);

    const violations = scanRetiredAuthorityReintroduction(REAL_MODULES);

    expect(
      violations,
      violations
        .map(
          (v) =>
            `${v.modulePath}:${v.line} [${v.authorityId}/${v.patternId}] ${v.snippet} — ${v.description}`,
        )
        .join('\n'),
    ).toEqual([]);
  });

  it('PassStateFix_ReintroductionInProductionSource_FailsMechanically', () => {
    // The teeth of the criterion above: plant each retired pattern back into a
    // production module and assert the scan catches every one. Without this the
    // "zero violations" assertion could be vacuous.
    const planted: readonly SourceModule[] = [
      {
        path: 'workflow/cleanup.ts',
        content: [
          'export function handleCleanup() {',
          "  entry.status = 'approved';",
          '  mutableState._cleanup = { mergeVerified: true };',
          '}',
        ].join('\n'),
        isTest: false,
      },
    ];

    const violations = scanRetiredAuthorityReintroduction(planted);

    expect(violations.length).toBeGreaterThanOrEqual(3);
    expect(new Set(violations.map((v) => v.patternId))).toEqual(
      new Set([
        'force-approve-review-status',
        'force-write-merge-verified',
        'force-write-cleanup-pass-state',
      ]),
    );
    expect(violations.every((v) => v.authorityId === 'cleanup-pass-state-fix')).toBe(true);
  });

  it('PassStateFix_TestModulesAreExempt_SoCharacterizationStaysWritable', () => {
    // Characterization fixtures must remain able to DESCRIBE the retired
    // behaviour; only production source is governed.
    const asTest: readonly SourceModule[] = [
      {
        path: 'workflow/cleanup.test.ts',
        content: "entry.status = 'approved';\nstate._cleanup = { mergeVerified: true };",
        isTest: true,
      },
    ];
    expect(scanRetiredAuthorityReintroduction(asTest)).toEqual([]);
  });

  it('PassStateFix_CommentedOutReintroduction_IsNotAViolation', () => {
    const commented: readonly SourceModule[] = [
      {
        path: 'workflow/cleanup.ts',
        content: "// entry.status = 'approved'; — retired by DR-8\n* mergeVerified: true",
        isTest: false,
      },
    ];
    expect(scanRetiredAuthorityReintroduction(commented)).toEqual([]);
  });

  it('PassStateFix_PatternNamedInsideAStringLiteral_IsNotAViolation', () => {
    // Prose that NAMES the retired pattern (an error message, this registry's
    // own descriptions) must not count as reinstating it — otherwise the scan
    // flags itself and has to be defanged to go green.
    const prose: readonly SourceModule[] = [
      {
        path: 'workflow/cleanup.ts',
        content: [
          "throw new Error('Cleanup requires mergeVerified: true — verify PRs are merged');",
          "const doc = '`_cleanup = { mergeVerified: true }` was the retired shape';",
          'const summary = `sets status = \\`approved\\` for you`;',
        ].join('\n'),
        isTest: false,
      },
    ];
    expect(scanRetiredAuthorityReintroduction(prose)).toEqual([]);
  });

  it('PassStateFix_DerivedMergeVerifiedVerdict_IsNotAViolation', () => {
    // The retirement forbids a HARD-CODED pass, not the evidence-derived write
    // cleanup now performs. If this went red the criterion would be unsatisfiable.
    const derived: readonly SourceModule[] = [
      {
        path: 'workflow/cleanup.ts',
        content: 'mutableState._cleanup = { mergeVerified: evidence.verified };',
        isTest: false,
      },
    ];
    expect(scanRetiredAuthorityReintroduction(derived)).toEqual([]);
  });
});

// ─── Registry consistency (requirement 2) ────────────────────────────────────

describe('DR-8 — retirement-safety registry reflects the retirement', () => {
  it('RetirementSafety_PassStateFixKind_IsAccountedForAsRetired', () => {
    // Before DR-8 `pass-state-fix` was a declared AuthorityKind with NO member
    // on either registry — a class nothing was accountable for. It must now be
    // named exactly once, as RETIRED.
    expect(AUTHORITY_KINDS).toContain('pass-state-fix');

    const retired = RETIRED_AUTHORITIES.filter((a) => a.kind === 'pass-state-fix');
    expect(retired.map((a) => a.id)).toEqual(['cleanup-pass-state-fix']);
    expect(retired[0].retiredBy).toBe('DR-8');
    expect(retired[0].forbiddenPatterns.length).toBeGreaterThan(0);
  });

  it('RetirementSafety_RetiredAndLegacyRegistries_DoNotOverlap', async () => {
    // The registry must not claim a retired fix is still awaiting retirement.
    const { LEGACY_AUTHORITIES } = await import('../../../src/workflow/retirement/retirement-safety.js');
    const legacyIds = new Set(LEGACY_AUTHORITIES.map((a) => a.id));
    for (const retired of RETIRED_AUTHORITIES) {
      expect(legacyIds.has(retired.id)).toBe(false);
    }
    // …and no LEGACY authority may still be filed under a retired kind.
    const retiredKinds = new Set(RETIRED_AUTHORITIES.map((a) => a.kind));
    for (const legacy of LEGACY_AUTHORITIES) {
      expect(retiredKinds.has(legacy.kind)).toBe(false);
    }
  });

  it('RetirementSafety_EveryForbiddenPattern_IsAValidRegExpWithAUniqueId', () => {
    for (const authority of RETIRED_AUTHORITIES) {
      const ids = authority.forbiddenPatterns.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const pattern of authority.forbiddenPatterns) {
        expect(() => new RegExp(pattern.pattern)).not.toThrow();
        expect(pattern.description.length).toBeGreaterThan(0);
      }
    }
  });
});
