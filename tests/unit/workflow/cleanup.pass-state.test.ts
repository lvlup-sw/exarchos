// Cleanup satisfies its merge guard only from evidence in the state.
// The retired `pass-state-fix` wrote the guard inputs and then asked the guard for permission.
//
// `state.reviews` is read-only evidence, and cleanup does not set a review to approved.
// `_cleanup.mergeVerified` is the verdict of `collectCleanupEvidence`.
// That verdict needs every existing review status to be `approved`, and a merge artifact reference.
// A reference is `synthesis.prUrl`, `artifacts.pr`, or `synthesis.mergedBranches`.
// The `state.patched` backfill does not carry `reviews`.
//
// Behavior tests do not stop the retired pattern from coming back in other code.
// Thus `scanRetiredAuthorityReintroduction` runs the forbidden patterns over the production tree, with tests excluded.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, '../../../src');

const TEST_PATH_RE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;
const TEST_DIR_RE =
  /(^|\/)(__tests__|__fixtures__|test-fixtures|test-helpers|evals)(\/|$)/;

function isTestPath(rel: string): boolean {
  return TEST_PATH_RE.test(rel) || TEST_DIR_RE.test(rel);
}

/** Loads every TypeScript module under `root`, skips `node_modules` and `dist`, and marks test paths. */
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
  /**
   * A merge artifact is already in the state, so the only missing evidence is the review approvals.
   * The guard fails, and cleanup changes no review.
   */
  it('Cleanup_UnapprovedReviews_DoesNotForceApprove', async () => {
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('reviews are not approved');
    expect(result.error?.message).toContain('t1');
    expect(result.error?.message).toContain('t2.specReview');

    const after = await readRawState('ps-unapproved');
    const reviews = after.reviews as Record<string, Record<string, unknown>>;
    expect(reviews['t1'].status).toBe('needs_fixes');
    expect((reviews['t2'].specReview as Record<string, unknown>).status).toBe('fail');
    expect(after.phase).toBe('review');
    expect(after._cleanup).toBeUndefined();
  });

  /**
   * The reviews are approved, but the state holds no merge record and the caller supplies none.
   * The `mergeVerified: true` input is an assertion, not evidence, so it is not enough.
   */
  it('Cleanup_MergeUnverified_FailsGuardByEvidence', async () => {
    await handleInit({ featureId: 'ps-nomerge', workflowType: 'feature' }, tmpDir, null);
    const raw = await readRawState('ps-nomerge');
    raw.phase = 'review';
    raw.reviews = { 't1': { status: 'approved' } };
    await writeRawState('ps-nomerge', raw);

    const result = await handleCleanup(
      { featureId: 'ps-nomerge', mergeVerified: true },
      tmpDir,
      null,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('no merge artifact reference recorded');

    const after = await readRawState('ps-nomerge');
    expect(after.phase).toBe('review');
  });

  /**
   * The caller supplies a `prUrl`, but the state holds no merge record.
   * Cleanup collects the evidence before it backfills the input, so the guard fails.
   * Init leaves both references null, and the failed call does not write the input values.
   */
  it('Cleanup_CallerMintedPrUrlOnly_FailsGuardByEvidence', async () => {
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

    const after = await readRawState('ps-caller-minted');
    expect(after.phase).toBe('review');
    expect((after.synthesis as Record<string, unknown> | undefined)?.prUrl ?? null).toBeNull();
    expect((after.artifacts as Record<string, unknown> | undefined)?.pr ?? null).toBeNull();
  });

  /** With real evidence, cleanup completes and leaves the reviews as it found them. */
  it('Cleanup_RealEvidence_SatisfiesGuardWithoutRewritingAnything', async () => {
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

  /** A reference that holds only whitespace is not evidence. The collector trims a real reference. */
  it('CollectCleanupEvidence_BlankArtifactReference_IsNotEvidence', () => {
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

describe('DR-8 — no production path writes the guard inputs', () => {
  /** The first two checks prove that the scan reads the real production modules. */
  it('PassStateFix_NoProductionSourceWritesReviewStatusOrMergeVerified', () => {
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

  /**
   * The scan must catch each retired pattern that the test plants in a production module.
   * Without this test, the zero-violation test can pass vacuously.
   */
  it('PassStateFix_ReintroductionInProductionSource_FailsMechanically', () => {
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

  /** A test module can still describe the retired pattern. The scan checks only production source. */
  it('PassStateFix_TestModulesAreExempt_SoCharacterizationStaysWritable', () => {
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

  /**
   * Text in a string that names the pattern, such as an error message, is not a violation.
   * Otherwise the scan flags the descriptions in its own registry.
   */
  it('PassStateFix_PatternNamedInsideAStringLiteral_IsNotAViolation', () => {
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

  /** The scan forbids a hard-coded pass, not the write of the verdict that cleanup derives from evidence. */
  it('PassStateFix_DerivedMergeVerifiedVerdict_IsNotAViolation', () => {
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

describe('DR-8 — retirement-safety registry reflects the retirement', () => {
  /** `pass-state-fix` is a declared authority kind, and exactly one retired authority carries it. */
  it('RetirementSafety_PassStateFixKind_IsAccountedForAsRetired', () => {
    expect(AUTHORITY_KINDS).toContain('pass-state-fix');

    const retired = RETIRED_AUTHORITIES.filter((a) => a.kind === 'pass-state-fix');
    expect(retired.map((a) => a.id)).toEqual(['cleanup-pass-state-fix']);
    expect(retired[0].retiredBy).toBe('DR-8');
    expect(retired[0].forbiddenPatterns.length).toBeGreaterThan(0);
  });

  /** No retired authority is also a legacy authority, and no legacy authority has a retired kind. */
  it('RetirementSafety_RetiredAndLegacyRegistries_DoNotOverlap', async () => {
    const { LEGACY_AUTHORITIES } = await import('../../../src/workflow/retirement/retirement-safety.js');
    const legacyIds = new Set(LEGACY_AUTHORITIES.map((a) => a.id));
    for (const retired of RETIRED_AUTHORITIES) {
      expect(legacyIds.has(retired.id)).toBe(false);
    }
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
