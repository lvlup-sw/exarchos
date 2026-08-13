// ─── check_test_adequacy: PRODUCTION-PATH proofs ─────────────────────────────
//
// Why this file exists at all.
//
// `test-adequacy.false-advisory.test.ts` calls `runProbe()` DIRECTLY. That is
// why a fully green suite coexisted with a live gate that returned a vacuous
// PASS: the direct-call fixtures pin the probe's own logic, but they never
// exercise the composition the MCP action actually travels —
//
//     exarchos_orchestrate(action:'check_test_adequacy')
//       → dispatch()                      (per-action Zod validation)
//       → handleOrchestrate               (adaptLadderGate)
//       → handleTestAdequacy              (preflight, repoRoot, toolchain globs)
//       → runDurableGateProducer → runGate
//       → runProbe
//
// Everything asserted here is asserted THROUGH that composition against a real
// git repo. Two independent defects lived in the gap and are pinned closed:
//
//   (a) SUBJECT — the handler threaded the detected toolchain's test globs as a
//       REPLACEMENT for the co-located conventions, so in any repo whose root
//       marker prescribes a layout (python/rust/ruby/…) a co-located
//       `*.test.ts` was classified as SOURCE. The gate resolved ZERO test files
//       for a task that plainly added tests → `no-new-tests` on the wrong
//       subject.
//
//   (b) REPRESENTABILITY — "the probe could not run" and "the probe ran and
//       passed" shared one boolean, so a SKIPPED check was indistinguishable
//       from a verified one in the carrier. The gate now reports a
//       `disposition` derived from the `ProbeVerdict` union, and an advisory
//       skip is stamped `skipped:true` — it can still be non-blocking, but it
//       can never again read as proof of test adequacy.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
  withTrustedCaller,
} from '../../../../tools/test-helpers/trusted-context.js';
import {
  interpretProbeVerdict,
  verdictOf,
  resolveProbeTestGlobs,
  DEFAULT_TEST_GLOBS,
  type AdequacyDiscriminant,
} from '../../../../src/verbs/gates/test-adequacy.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function initRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/** The carrier shape the gate returns (INV-5b advisory). */
interface AdequacyData {
  readonly passed: boolean;
  readonly disposition?: string;
  readonly skipped?: boolean;
  readonly probedTests?: readonly string[];
  readonly discriminant?: string;
  readonly report?: string;
  readonly redObserved?: boolean;
  readonly restoredClean?: boolean;
}

function dataOf(result: { readonly data?: unknown }): AdequacyData {
  const data = result.data;
  if (typeof data !== 'object' || data === null) {
    throw new Error(`expected an object carrier, got ${JSON.stringify(data)}`);
  }
  return data as AdequacyData;
}

describe('check_test_adequacy production path', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
        /* best-effort */
      }
    }
  });

  async function makeCtx(prefix: string, featureId: string): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    await seedActivePhaseAttempt(eventStore, featureId);
    return withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as DispatchContext);
  }

  /** A task branch that changes ONLY source — nothing for the probe to kill. */
  function sourceOnlyBranch(prefix: string): string {
    const repoRoot = initRepo(prefix);
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"fx","version":"1.0.0"}\n');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const v = () => 1;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'base', '-q']);
    git(repoRoot, ['checkout', '-b', 'feature/src-only', '-q']);
    writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const v = () => 2;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'source only — ships no tests', '-q']);
    return repoRoot;
  }

  // ── REQUIRED PROOF 2 — the observed vacuous-pass scenario, preserved ───────

  it('ObservedVacuousPass_HighTierNoProbeableTests_Blocks', async () => {
    // The EXACT live payload this fix answers:
    //   {"passed":true,"redObserved":false,"restoredClean":true,"probedTests":[],
    //    "discriminant":"no-new-tests","report":"nothing to probe — task adds no tests"}
    // returned for riskTier:'high'. A high-tier task whose kill probe did not
    // run is UNVERIFIED, and the gate must block rather than advise.
    const repoRoot = sourceOnlyBranch('prodpath-observed-');
    const ctx = await makeCtx('prodpath-observed-state-', 'feat-observed');

    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'check_test_adequacy',
        featureId: 'feat-observed',
        taskId: 'PDD-PROBE-A',
        branch: 'feature/src-only',
        baseBranch: 'main',
        repoRoot,
        riskTier: 'high',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    // The verdict is INDETERMINATE (the probe did not run) and the high tier
    // requires it, so the gate BLOCKS.
    expect(data.passed).toBe(false);
    expect(data.disposition).toBe('blocked');
    expect(data.discriminant).toBe('no-new-tests');
    expect(data.probedTests).toEqual([]);
    // A blocked indeterminate is NOT a skip.
    expect(data.skipped).toBeUndefined();
    expect(data.report).toContain('requires a kill probe');
  }, 180_000);

  // ── REQUIRED PROOF 1 — a skipped check can never read as proof ────────────

  it('ProductionPath_UnstampedTierNoProbeableTests_LabelledSkipNotProof', async () => {
    // THE structural fix. When no tier is stamped the gate may still degrade to
    // a NON-BLOCKING advisory (INV-4) — but the carrier must say so out loud.
    //
    // Pre-fix the carrier was `{passed:true, discriminant:'no-new-tests',
    // report:'nothing to probe — task adds no tests'}` with NO skip marker at
    // all: a check that never ran was, on the wire, byte-indistinguishable from
    // a check that ran and proved the tests non-vacuous. That is the defect
    // class — "could not run" and "ran and passed" sharing one channel — and
    // these two assertions are what fail without the `ProbeVerdict` union.
    const repoRoot = sourceOnlyBranch('prodpath-skip-');
    const ctx = await makeCtx('prodpath-skip-state-', 'feat-skip');

    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'check_test_adequacy',
        featureId: 'feat-skip',
        taskId: 'T-unstamped',
        branch: 'feature/src-only',
        baseBranch: 'main',
        repoRoot,
        // NO riskTier — the legacy/unstamped caller.
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    // Non-blocking is allowed …
    expect(data.passed).toBe(true);
    // … but ONLY as an explicitly-labelled SKIP, never as proof.
    expect(data.skipped).toBe(true);
    expect(data.disposition).toBe('advisory-skip');
    expect(data.disposition).not.toBe('proved');
    expect(data.report).toMatch(/advisory\s+SKIP/i);
    expect(data.report).toMatch(/NOT proof/i);
  }, 180_000);

  // ── REQUIRED PROOF 3 — the gate must probe the RIGHT subject ──────────────

  it('ProductionPath_ColocatedTestsUnderLayoutToolchain_ResolvesNonEmptyProbedTests', async () => {
    // SUBJECT FAULT (a). A polyglot repo whose ROOT marker is python
    // (`pyproject.toml`) but whose tests are co-located `*.test.ts`. The task
    // genuinely changes a test file, so the probe MUST see it.
    //
    // Pre-fix `testGlobsForToolchain('python')` REPLACED the co-located
    // defaults, so `src/calc.test.ts` was classified as SOURCE, `probedTests`
    // came back `[]`, and the gate reported `no-new-tests` for a task that
    // plainly added a test — the gate probing the wrong subject.
    const repoRoot = initRepo('prodpath-subject-');
    cleanups.push(() => rmSync(repoRoot, { recursive: true, force: true }));
    writeFileSync(path.join(repoRoot, 'pyproject.toml'), '[project]\nname = "fx"\n');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'calc.ts'), 'export const v = () => 1;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'base', '-q']);
    git(repoRoot, ['checkout', '-b', 'feature/ts', '-q']);
    writeFileSync(path.join(repoRoot, 'src', 'calc.ts'), 'export const v = () => 2;\n');
    writeFileSync(path.join(repoRoot, 'src', 'calc.test.ts'), '// pins v() === 2\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-m', 'feat + co-located test', '-q']);

    const ctx = await makeCtx('prodpath-subject-state-', 'feat-subject');

    const result = await runAsTrustedCaller(ctx.stateDir, () =>
      handleOrchestrate(
        {
          action: 'check_test_adequacy',
          featureId: 'feat-subject',
          taskId: 'T-subject',
          branch: 'feature/ts',
          baseBranch: 'main',
          repoRoot,
          riskTier: 'high',
          // Injected so no real test runner is needed; the probe reports RED on
          // the reverted source, which is the genuine kill.
          runTests: async () => ({ passed: false, output: 'red on revert' }),
        },
        ctx,
      ),
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.probedTests).toEqual(expect.arrayContaining(['src/calc.test.ts']));
    expect(data.probedTests?.length ?? 0).toBeGreaterThan(0);
    expect(data.discriminant).not.toBe('no-new-tests');
    // Right subject + observed kill ⇒ a real proof, not a skip.
    expect(data.disposition).toBe('proved');
    expect(data.passed).toBe(true);
    expect(data.skipped).toBeUndefined();
  }, 180_000);

  // ── Execution failures fail closed on EVERY tier, and are never skips ─────

  it('ProductionPath_DiffFailure_BlocksEvenAtLowTier', async () => {
    // `diff-failed` is indeterminate too, but it is an EXECUTION failure of a
    // probe that was supposed to run — not a legitimate "nothing to do". It
    // must never degrade to an advisory skip, even on the low tier.
    const repoRoot = sourceOnlyBranch('prodpath-difffail-');
    const ctx = await makeCtx('prodpath-difffail-state-', 'feat-difffail');

    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'check_test_adequacy',
        featureId: 'feat-difffail',
        taskId: 'T-difffail',
        branch: 'refs/heads/branch-that-does-not-exist',
        baseBranch: 'main',
        repoRoot,
        riskTier: 'low',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(false);
    expect(data.disposition).toBe('blocked');
    expect(data.discriminant).toBe('diff-failed');
    expect(data.skipped).toBeUndefined();
  }, 180_000);
});

// ─── Unit-level pins on the verdict algebra ──────────────────────────────────

describe('ProbeVerdict algebra', () => {
  const ALL_CAUSES: readonly AdequacyDiscriminant[] = [
    'no-new-tests',
    'revert-conflict',
    'restore-failed',
    'diff-failed',
  ];

  it('Indeterminate_AtRequiredTier_NeverPasses', () => {
    for (const cause of ALL_CAUSES) {
      for (const tier of ['medium', 'high'] as const) {
        const interpretation = interpretProbeVerdict(
          { kind: 'indeterminate', cause, detail: 'probe did not run' },
          tier,
        );
        expect(interpretation.passed).toBe(false);
        expect(interpretation.disposition).toBe('blocked');
        expect(interpretation.skipped).toBe(false);
      }
    }
  });

  it('Indeterminate_AtLowTier_IsAlwaysLabelledSkipWhenNonBlocking', () => {
    for (const cause of ALL_CAUSES) {
      const interpretation = interpretProbeVerdict(
        { kind: 'indeterminate', cause, detail: 'probe did not run' },
        'low',
      );
      // Whatever the policy decides, an indeterminate verdict is NEVER
      // reported as a proof: it is either blocked, or an explicit skip.
      expect(interpretation.disposition).not.toBe('proved');
      if (interpretation.passed) {
        expect(interpretation.skipped).toBe(true);
        expect(interpretation.disposition).toBe('advisory-skip');
      } else {
        expect(interpretation.disposition).toBe('blocked');
      }
    }
  });

  it('ExecutionFailureCauses_BlockOnEveryTier', () => {
    for (const cause of ['revert-conflict', 'restore-failed', 'diff-failed'] as const) {
      for (const tier of [undefined, 'low', 'medium', 'high']) {
        const interpretation = interpretProbeVerdict(
          { kind: 'indeterminate', cause, detail: 'probe could not execute' },
          tier,
        );
        expect(interpretation.passed).toBe(false);
        expect(interpretation.disposition).toBe('blocked');
      }
    }
  });

  it('Failed_IsNeverDowngradedByTier', () => {
    for (const tier of [undefined, 'low', 'medium', 'high']) {
      const interpretation = interpretProbeVerdict(
        { kind: 'failed', reason: 'tests stayed green', probedTests: ['a.test.ts'] },
        tier,
      );
      expect(interpretation.passed).toBe(false);
      expect(interpretation.disposition).toBe('blocked');
    }
  });

  it('VerdictOf_LegacyVacuousCarrier_ReconstructsIndeterminateNotPass', () => {
    // A hand-authored legacy carrier claiming `passed:true` alongside a
    // "could not run" discriminant must NOT be trusted: `verdictOf` never reads
    // `passed`, so the claim cannot smuggle a skipped check through as success.
    const verdict = verdictOf({
      passed: true,
      redObserved: false,
      restoredClean: true,
      probedTests: [],
      discriminant: 'no-new-tests',
      report: 'nothing to probe — task adds no tests',
    });
    expect(verdict.kind).toBe('indeterminate');
    // …and at a required tier that reconstruction blocks.
    expect(interpretProbeVerdict(verdict, 'high').passed).toBe(false);
  });

  it('VerdictOf_UnknownDiscriminant_FailsClosed', () => {
    const verdict = verdictOf({
      passed: true,
      redObserved: true,
      restoredClean: true,
      probedTests: [],
      discriminant: 'some-future-mode',
    });
    expect(verdict.kind).toBe('failed');
    expect(interpretProbeVerdict(verdict, 'low').passed).toBe(false);
  });

  it('ResolveProbeTestGlobs_AugmentsRatherThanReplacesColocatedDefaults', () => {
    const merged = resolveProbeTestGlobs(['tests/**', '**/test_*.py']);
    for (const glob of DEFAULT_TEST_GLOBS) {
      expect(merged).toContain(glob);
    }
    expect(merged).toContain('tests/**');
    expect(merged).toContain('**/test_*.py');
    // No toolchain layout → the co-located defaults, unchanged.
    expect(resolveProbeTestGlobs(null)).toEqual(DEFAULT_TEST_GLOBS);
  });
});
