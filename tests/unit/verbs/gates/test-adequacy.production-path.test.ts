/**
 * These tests run `check_test_adequacy` against a real git repo through the
 * production path: `dispatch()`, `handleOrchestrate`, `handleTestAdequacy`, the
 * durable gate producer, and `runProbe`. `test-adequacy.false-advisory.test.ts`
 * calls `runProbe()` directly and does not cover this path.
 *
 * The tests pin two facts. The probe adds the toolchain test globs to the
 * co-located defaults, so a co-located `*.test.ts` file is a test file. A
 * skipped probe reports `skipped: true` and a `disposition`, so it never reads
 * as proof of test adequacy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { dispatch } from '../../../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
  withTrustedCaller,
} from '../../../../tools/test-helpers/trusted-context.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import {
  interpretProbeVerdict,
  verdictOf,
  resolveProbeTestGlobs,
  DEFAULT_TEST_GLOBS,
  type AdequacyDiscriminant,
} from '../../../../src/verbs/gates/test-adequacy.js';


function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/** The carrier that the gate returns. */
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

/** `sourceOnlyBranch` builds a task branch that changes only source, so the probe has nothing to kill. */
describe('check_test_adequacy production path', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
  });

  async function makeCtx(prefix: string, featureId: string): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rmrf(stateDir));
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    await seedActivePhaseAttempt(eventStore, featureId);
    return withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
    } as DispatchContext);
  }

  async function sourceOnlyBranch(prefix: string): Promise<string> {
    const repoRoot = await initRepo(prefix);
    cleanups.push(() => rmrf(repoRoot));
    writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"fx","version":"1.0.0"}\n');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const v = () => 1;\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'base', '-q']);
    await git(repoRoot, ['checkout', '-b', 'feature/src-only', '-q']);
    writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const v = () => 2;\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'source only — ships no tests', '-q']);
    return repoRoot;
  }

  /**
   * A high-tier task with no tests to probe gets an indeterminate verdict,
   * because the probe did not run. The high tier requires a probe, so the gate
   * blocks. A block is not a skip.
   */
  it('ObservedVacuousPass_HighTierNoProbeableTests_Blocks', async () => {
    const repoRoot = await sourceOnlyBranch('prodpath-observed-');
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
    expect(data.passed).toBe(false);
    expect(data.disposition).toBe('blocked');
    expect(data.discriminant).toBe('no-new-tests');
    expect(data.probedTests).toEqual([]);
    expect(data.skipped).toBeUndefined();
    expect(data.report).toContain('requires a kill probe');
  }, 180_000);

  /**
   * With no risk tier, the gate can pass as a non-blocking advisory. The
   * carrier must then mark the result as a skip, so a probe that did not run
   * never looks like a probe that passed.
   */
  it('ProductionPath_UnstampedTierNoProbeableTests_LabelledSkipNotProof', async () => {
    const repoRoot = await sourceOnlyBranch('prodpath-skip-');
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
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.disposition).toBe('advisory-skip');
    expect(data.disposition).not.toBe('proved');
    expect(data.report).toMatch(/advisory\s+SKIP/i);
    expect(data.report).toMatch(/NOT proof/i);
  }, 180_000);

  /**
   * A low-tier task that touches no boundary leaves this gate out of the
   * verification sequence, so `resolvePolicySkip` skips it. The carrier passes,
   * but the durable rows must record a skip. The evidence verdict is
   * `indeterminate`, and the `test-adequacy` `gate.executed` row has
   * `passed: false` with the reason in `details`.
   */
  it('ProductionPath_PolicySkippedGate_DurableRowsRecordSkipNotPass', async () => {
    const repoRoot = await sourceOnlyBranch('prodpath-durable-skip-');
    const ctx = await makeCtx('prodpath-durable-skip-state-', 'feat-durable-skip');

    const result = await dispatch(
      'exarchos_orchestrate',
      {
        action: 'check_test_adequacy',
        featureId: 'feat-durable-skip',
        taskId: 'T-durable-skip',
        branch: 'feature/src-only',
        baseBranch: 'main',
        repoRoot,
        riskTier: 'low',
        boundaryTouching: false,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.passed).toBe(true);
    expect(data.skipped).toBe(true);

    const evidenceRows = await ctx.eventStore.query('feat-durable-skip', {
      type: 'admission.evidence-recorded',
    });
    expect(evidenceRows.length).toBeGreaterThan(0);
    const verdicts = evidenceRows.map(
      (e) => (e.data as { evidence?: { verdict?: string } }).evidence?.verdict,
    );
    expect(verdicts).toContain('indeterminate');
    expect(verdicts).not.toContain('pass');

    const gateRows = await ctx.eventStore.query('feat-durable-skip', {
      type: 'gate.executed',
    });
    const adequacy = gateRows
      .map((e) => e.data as { gateName?: string; passed?: boolean; details?: Record<string, unknown> })
      .filter((d) => d.gateName === 'test-adequacy');
    expect(adequacy.length).toBeGreaterThan(0);
    for (const row of adequacy) {
      expect(row.passed).toBe(false);
      expect(row.details).toMatchObject({ verdict: 'indeterminate', skipped: true });
      expect(typeof row.details?.discriminant).toBe('string');
    }
  }, 180_000);

  /**
   * The root marker `pyproject.toml` selects python, but the task adds the
   * co-located test `src/calc.test.ts`. The probe must include that file. The
   * injected `runTests` reports red on the reverted source, so the disposition
   * is `proved`.
   */
  it('ProductionPath_ColocatedTestsUnderLayoutToolchain_ResolvesNonEmptyProbedTests', async () => {
    const repoRoot = await initRepo('prodpath-subject-');
    cleanups.push(() => rmrf(repoRoot));
    writeFileSync(path.join(repoRoot, 'pyproject.toml'), '[project]\nname = "fx"\n');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'calc.ts'), 'export const v = () => 1;\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'base', '-q']);
    await git(repoRoot, ['checkout', '-b', 'feature/ts', '-q']);
    writeFileSync(path.join(repoRoot, 'src', 'calc.ts'), 'export const v = () => 2;\n');
    writeFileSync(path.join(repoRoot, 'src', 'calc.test.ts'), '// pins v() === 2\n');
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'feat + co-located test', '-q']);

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
    expect(data.disposition).toBe('proved');
    expect(data.passed).toBe(true);
    expect(data.skipped).toBeUndefined();
  }, 180_000);

  /**
   * `diff-failed` is an execution failure of the probe, not an empty subject.
   * It blocks the gate even at the low tier and is not a skip.
   */
  it('ProductionPath_DiffFailure_BlocksEvenAtLowTier', async () => {
    const repoRoot = await sourceOnlyBranch('prodpath-difffail-');
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

  /** An indeterminate verdict is never a proof. It is blocked or an explicit skip. */
  it('Indeterminate_AtLowTier_IsAlwaysLabelledSkipWhenNonBlocking', () => {
    for (const cause of ALL_CAUSES) {
      const interpretation = interpretProbeVerdict(
        { kind: 'indeterminate', cause, detail: 'probe did not run' },
        'low',
      );
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

  /**
   * `verdictOf` does not read `passed`, so a carrier that claims `passed: true`
   * with a "could not run" discriminant becomes an indeterminate verdict. At a
   * required tier, that verdict blocks.
   */
  it('VerdictOf_LegacyVacuousCarrier_ReconstructsIndeterminateNotPass', () => {
    const verdict = verdictOf({
      passed: true,
      redObserved: false,
      restoredClean: true,
      probedTests: [],
      discriminant: 'no-new-tests',
      report: 'nothing to probe — task adds no tests',
    });
    expect(verdict.kind).toBe('indeterminate');
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

  /** With no toolchain layout, the result is the co-located defaults. */
  it('ResolveProbeTestGlobs_AugmentsRatherThanReplacesColocatedDefaults', () => {
    const merged = resolveProbeTestGlobs(['tests/**', '**/test_*.py']);
    for (const glob of DEFAULT_TEST_GLOBS) {
      expect(merged).toContain(glob);
    }
    expect(merged).toContain('tests/**');
    expect(merged).toContain('**/test_*.py');
    expect(resolveProbeTestGlobs(null)).toEqual(DEFAULT_TEST_GLOBS);
  });
});
