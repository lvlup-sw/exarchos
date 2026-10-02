/**
 * Tests for the doctor composer, which runs the checks as one action. The tests
 * pass check lists to `handleDoctorWithChecks`. Thus they cover parallel runs,
 * timeouts, and abort without real probe work.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { makeStubProbes } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import type { CheckFn } from '../../../../src/verbs/doctor/checks/__shared__/make-stub-probes.js';
import { DEFAULT_CHECK_BUDGET_MS, type DoctorProbes } from '../../../../src/verbs/doctor/probes.js';
import type { AgentEnvironment } from '../../../../src/runtime/agent-environment-detector.js';
import type { IntegrityResult } from '../../../../src/events/store.js';
import type { BundleIntegrityResult } from '../../../../src/events/bundle/integrity.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { handleDoctorWithChecks, ALL_CHECKS } from '../../../../src/verbs/doctor/index.js';

function fakeContext(): DispatchContext {
  return {
    stateDir: '/tmp/doctor-test',
    eventStore: { append: vi.fn(async () => ({})) } as unknown as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
}

function fakeContextWithProbes(): { ctx: DispatchContext; buildProbes: () => ReturnType<typeof makeStubProbes> } {
  const ctx = fakeContext();
  return { ctx, buildProbes: () => makeStubProbes() };
}

/**
 * Builds `count` checks that each wait until all of them have started. They can
 * all finish only when the composer runs them at the same time. Thus a
 * `maxRunning()` of `count` proves parallel execution without reading a clock.
 */
function concurrentChecks(count: number): { checks: CheckFn[]; maxRunning: () => number } {
  let running = 0;
  let maxRunning = 0;
  let releaseAll: () => void = () => undefined;
  const allStarted = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const checks = Array.from({ length: count }, (_, index): CheckFn => async (): Promise<CheckResult> => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    if (running === count) releaseAll();
    await allStarted;
    running -= 1;
    return {
      category: 'runtime',
      name: `c${index + 1}`,
      status: 'Pass',
      message: 'started alongside every other check',
      durationMs: 0,
    };
  });
  return { checks, maxRunning: () => maxRunning };
}

/** Builds a check that never resolves, so it always runs past the timeout. */
function hangingCheck(name: string): CheckFn {
  return async () => {
    await new Promise<void>(() => {});
    return {
      category: 'runtime',
      name,
      status: 'Pass',
      message: 'unreachable',
      durationMs: 0,
    };
  };
}

describe('handleDoctor — parallel execution + timeout', () => {
  /**
   * Four checks each sleep 500ms. In sequence they take about 2000ms. In
   * parallel they take about 500ms plus overhead.
   */
  it('HandleDoctor_AllChecksRunInParallel_TotalTimeLessThanSequentialSum', async () => {
    const { ctx } = fakeContextWithProbes();
    const { checks, maxRunning } = concurrentChecks(4);

    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    expect(result.success).toBe(true);
    expect(maxRunning()).toBe(4);
    expect(result.data).toMatchObject({
      checks: [{ status: 'Pass' }, { status: 'Pass' }, { status: 'Pass' }, { status: 'Pass' }],
    });
  });

  it('HandleDoctor_CheckExceedsTimeout_ReturnsWarningWithTimeoutFix', async () => {
    const { ctx } = fakeContextWithProbes();
    const checks: CheckFn[] = [hangingCheck('hang')];

    const result = await handleDoctorWithChecks(
      { timeoutMs: 50 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks).toHaveLength(1);
    const [c] = data.checks;
    expect(c.status).toBe('Warning');
    expect(c.fix).toBeDefined();
    expect(c.fix).toContain('50ms timeout');
  });

  it('HandleDoctor_MixedResults_ReturnsCorrectSummaryTally', async () => {
    const { ctx } = fakeContextWithProbes();
    const mkResult = (status: CheckResult['status'], name: string): CheckFn => async () => {
      const base = { category: 'runtime' as const, name, durationMs: 0 };
      if (status === 'Skipped') {
        return { ...base, status, message: `${name} skipped`, reason: 'not applicable' };
      }
      if (status === 'Warning' || status === 'Fail') {
        return { ...base, status, message: `${name} ${status.toLowerCase()}`, fix: `fix ${name}` };
      }
      return { ...base, status, message: `${name} ${status.toLowerCase()}` };
    };
    const checks: CheckFn[] = [
      mkResult('Pass', 'p1'),
      mkResult('Pass', 'p2'),
      mkResult('Warning', 'w1'),
      mkResult('Fail', 'f1'),
      mkResult('Skipped', 's1'),
    ];

    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { summary: { passed: number; warnings: number; failed: number; skipped: number } };
    expect(data.summary).toEqual({ passed: 2, warnings: 1, failed: 1, skipped: 1 });
  });

  it('HandleDoctor_AllPass_SummaryEqualsChecksLength', async () => {
    const { ctx } = fakeContextWithProbes();
    const mkPass = (name: string): CheckFn => async () => ({
      category: 'runtime',
      name,
      status: 'Pass',
      message: `${name} ok`,
      durationMs: 0,
    });
    const checks: CheckFn[] = [mkPass('a'), mkPass('b'), mkPass('c')];

    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[]; summary: { passed: number } };
    expect(data.summary.passed).toBe(data.checks.length);
    expect(data.summary.passed).toBe(3);
  });

  it('HandleDoctor_OnCompletion_AppendsDiagnosticExecutedEventWithSummaryAndFailedNames', async () => {
    const appendSpy = vi.fn(async () => ({}));
    const ctx: DispatchContext = {
      stateDir: '/tmp/doctor-test',
      eventStore: { append: appendSpy } as unknown as DispatchContext['eventStore'],
      enableTelemetry: false,
    };
    const passCheck: CheckFn = async () => ({
      category: 'runtime',
      name: 'ok',
      status: 'Pass',
      message: 'ok',
      durationMs: 0,
    });
    const failCheck: CheckFn = async () => ({
      category: 'runtime',
      name: 'broken',
      status: 'Fail',
      message: 'broken',
      fix: 'fix it',
      durationMs: 0,
    });

    await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      [passCheck, failCheck],
      () => makeStubProbes(),
    );

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const [streamId, event] = appendSpy.mock.calls[0] as [string, { type: string; data: unknown }];
    expect(typeof streamId).toBe('string');
    expect(streamId.length).toBeGreaterThan(0);
    expect(event.type).toBe('diagnostic.executed');
    const data = event.data as {
      summary: { passed: number; warnings: number; failed: number; skipped: number };
      checkCount: number;
      failedCheckNames: string[];
      durationMs: number;
    };
    expect(data.summary).toEqual({ passed: 1, warnings: 0, failed: 1, skipped: 0 });
    expect(data.checkCount).toBe(2);
    expect(data.failedCheckNames).toEqual(['broken']);
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
  });

  /** The external abort fires before the check gives a result, so no partial event is written. */
  it('HandleDoctor_OnAbort_DoesNotAppendEvent', async () => {
    const appendSpy = vi.fn(async () => ({}));
    const ctx: DispatchContext = {
      stateDir: '/tmp/doctor-test',
      eventStore: { append: appendSpy } as unknown as DispatchContext['eventStore'],
      enableTelemetry: false,
    };
    const controller = new AbortController();
    const slow: CheckFn = async (_probes, signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
      return {
        category: 'runtime',
        name: 'slow',
        status: 'Pass',
        message: 'unreachable',
        durationMs: 0,
      };
    };

    setTimeout(() => controller.abort(), 10);
    await expect(
      handleDoctorWithChecks(
        { timeoutMs: 5000, externalSignal: controller.signal },
        ctx,
        [slow],
        () => makeStubProbes(),
      ),
    ).rejects.toThrow(/abort/i);

    expect(appendSpy).not.toHaveBeenCalled();
  });

  /** A caller can cancel a run in progress through `externalSignal`. */
  it('HandleDoctor_AbortSignalFired_RejectsWithAbortError', async () => {
    const { ctx } = fakeContextWithProbes();
    const controller = new AbortController();

    const abortingCheck: CheckFn = async (_probes, signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
      return {
        category: 'runtime',
        name: 'abort-target',
        status: 'Pass',
        message: 'unreachable',
        durationMs: 0,
      };
    };

    setTimeout(() => controller.abort(), 20);
    await expect(
      handleDoctorWithChecks(
        { timeoutMs: 5000, externalSignal: controller.signal },
        ctx,
        [abortingCheck],
        () => makeStubProbes(),
      ),
    ).rejects.toThrow(/abort/i);
  });
});

/**
 * A probe bundle where each real check in `ALL_CHECKS` returns a result. The
 * tests run the real roster through `handleDoctorWithChecks`, not one check
 * directly. A direct call skips dispatch and can hide a check that dispatch
 * does not reach.
 */
function benignProbes(): DoctorProbes {
  const emptyEnvironments: AgentEnvironment[] = [];
  return {
    checkBudgetMs: DEFAULT_CHECK_BUDGET_MS,
    fs: {
      readFile: async () => '',
      stat: (async () => ({
        isDirectory: () => true,
        isFile: () => false,
      })) as unknown as DoctorProbes['fs']['stat'],
      access: async () => undefined,
    },
    env: {},
    git: {
      which: async () => '/usr/bin/git',
      isRepo: async () => true,
      version: async () => 'git version 2.40.0',
    },
    sqlite: {
      runIntegrityCheck: vi.fn(async (): Promise<IntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign dispatch probe',
      })),
    },
    bundles: {
      runIntegrityCheck: vi.fn(async (): Promise<BundleIntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign dispatch probe',
      })),
    },
    detector: async () => emptyEnvironments,
    eventStore: { append: async () => ({}) } as unknown as DoctorProbes['eventStore'],
    runtime: { nodeVersion: process.version },
    stateDir: '/tmp/doctor-verification-toolchain-dispatch',
    skills: { guardStatus: async () => ({ inSync: true }) },
    plugin: {
      installedVersion: async () => null,
      runningVersion: async () => null,
    },
    invariants: { resolve: async () => ({ configured: false, warnings: [] }) },
    verificationToolchain: {
      resolve: async () => ({
        detected: true,
        runtime: {
          test: 'npm run test:run',
          typecheck: 'tsc --noEmit',
          install: 'npm install',
          mutation: 'npx stryker run',
          lint: 'eslint .',
        },
        policyCells: [
          { riskTier: 'low', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'low', boundaryTouching: true, source: 'builtin' },
          { riskTier: 'medium', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'medium', boundaryTouching: true, source: 'builtin' },
          { riskTier: 'high', boundaryTouching: false, source: 'builtin' },
          { riskTier: 'high', boundaryTouching: true, source: 'builtin' },
        ],
      }),
    },
  };
}

describe('handleDoctor — verification-toolchain roster (task 009)', () => {
  /**
   * The roster holds the pinned count of checks. The verification-toolchain
   * check appears with its name and category in the output of the composer,
   * not only in the export. With the benign probe it gives Pass, and its six
   * policy cells pass `DoctorOutputSchema.parse`.
   */
  it('HandleDoctorWithChecks_RosterIncludesVerificationToolchain_FifteenChecks', async () => {
    const ctx = fakeContext();

    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      ALL_CHECKS,
      () => benignProbes(),
    );

    expect(ALL_CHECKS).toHaveLength(20);
    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks).toHaveLength(20);

    const vt = data.checks.find((c) => c.name === 'verification-toolchain');
    expect(vt).toBeDefined();
    expect(vt!.category).toBe('verification');
    expect(vt!.status).toBe('Pass');
    expect(vt!.policyCells).toHaveLength(6);
  });

  /**
   * The block-drift check and the retired-hooks check both reach the output of
   * the composer, not only the static list. The drift check has the `agent`
   * category. It comes before the retired-hooks check, the same order that the
   * reconciler gives their plan steps.
   */
  it('HandleDoctorWithChecks_RosterIncludesBlockDriftAndRetiredHooks', async () => {
    const ctx = fakeContext();
    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      ALL_CHECKS,
      () => benignProbes(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[] };
    const names = data.checks.map((c) => c.name);
    expect(names).toContain('onramp-block-drift');
    expect(names).toContain('retired-hooks-present');

    const drift = data.checks.find((c) => c.name === 'onramp-block-drift');
    expect(drift!.category).toBe('agent');
    expect(names.indexOf('onramp-block-drift')).toBeLessThan(
      names.indexOf('retired-hooks-present'),
    );
  });
});
