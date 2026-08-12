/**
 * Tests for handleDoctor — the composer that wires all per-check
 * modules into a single MCP action. Tests inject explicit check lists
 * via `handleDoctorWithChecks` (the testable seam) so parallelism,
 * timeout semantics, and abort propagation can be exercised without
 * spawning any real probe work.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DispatchContext } from '../../core/dispatch.js';
import { makeStubProbes } from './checks/__shared__/make-stub-probes.js';
import type { CheckFn } from './checks/__shared__/make-stub-probes.js';
import type { DoctorProbes } from './probes.js';
import type { AgentEnvironment } from '../../runtime/agent-environment-detector.js';
import type { IntegrityResult } from '../../events/store.js';
import type { CheckResult } from './schema.js';
import { handleDoctorWithChecks, ALL_CHECKS } from './index.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

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

/** Build a check that sleeps for `ms` and returns a Pass result. */
function sleepingCheck(name: string, ms: number): CheckFn {
  return async (_probes, signal): Promise<CheckResult> => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    return {
      category: 'runtime',
      name,
      status: 'Pass',
      message: `slept ${ms}ms`,
      durationMs: ms,
    };
  };
}

/** Build a check that runs longer than the timeout budget. */
function hangingCheck(name: string): CheckFn {
  return async () => {
    await new Promise<void>(() => {}); // never resolves
    // unreachable
    return {
      category: 'runtime',
      name,
      status: 'Pass',
      message: 'unreachable',
      durationMs: 0,
    };
  };
}

// ─── Task 014 — parallel execution + per-check timeout ─────────────────────

describe('handleDoctor — parallel execution + timeout', () => {
  it('HandleDoctor_AllChecksRunInParallel_TotalTimeLessThanSequentialSum', async () => {
    // Arrange: 4 checks each sleeping 500ms. Sequential total would be
    // ~2000ms; parallel should finish in ~500ms plus overhead.
    const { ctx } = fakeContextWithProbes();
    const checks: CheckFn[] = [
      sleepingCheck('c1', 500),
      sleepingCheck('c2', 500),
      sleepingCheck('c3', 500),
      sleepingCheck('c4', 500),
    ];

    // Act
    const start = Date.now();
    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );
    const elapsed = Date.now() - start;

    // Assert: success, and well below the sequential sum (2000ms).
    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('HandleDoctor_CheckExceedsTimeout_ReturnsWarningWithTimeoutFix', async () => {
    // Arrange
    const { ctx } = fakeContextWithProbes();
    const checks: CheckFn[] = [hangingCheck('hang')];

    // Act
    const result = await handleDoctorWithChecks(
      { timeoutMs: 50 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks).toHaveLength(1);
    const [c] = data.checks;
    expect(c.status).toBe('Warning');
    expect(c.fix).toBeDefined();
    expect(c.fix).toContain('50ms timeout');
  });

  it('HandleDoctor_MixedResults_ReturnsCorrectSummaryTally', async () => {
    // Arrange: 2 Pass, 1 Warning, 1 Fail, 1 Skipped.
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

    // Act
    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    // Assert: summary tally matches the input mix.
    expect(result.success).toBe(true);
    const data = result.data as { summary: { passed: number; warnings: number; failed: number; skipped: number } };
    expect(data.summary).toEqual({ passed: 2, warnings: 1, failed: 1, skipped: 1 });
  });

  it('HandleDoctor_AllPass_SummaryEqualsChecksLength', async () => {
    // Arrange: 3 passing checks.
    const { ctx } = fakeContextWithProbes();
    const mkPass = (name: string): CheckFn => async () => ({
      category: 'runtime',
      name,
      status: 'Pass',
      message: `${name} ok`,
      durationMs: 0,
    });
    const checks: CheckFn[] = [mkPass('a'), mkPass('b'), mkPass('c')];

    // Act
    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      checks,
      () => makeStubProbes(),
    );

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[]; summary: { passed: number } };
    expect(data.summary.passed).toBe(data.checks.length);
    expect(data.summary.passed).toBe(3);
  });

  it('HandleDoctor_OnCompletion_AppendsDiagnosticExecutedEventWithSummaryAndFailedNames', async () => {
    // Arrange: 1 pass, 1 fail — captures the event append call via a
    // spy on the in-memory eventStore double.
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

    // Act
    await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      [passCheck, failCheck],
      () => makeStubProbes(),
    );

    // Assert: one diagnostic.executed event was appended with the
    // expected data shape.
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

  it('HandleDoctor_OnAbort_DoesNotAppendEvent', async () => {
    // Arrange: a long-sleeping check; the external abort fires before
    // any result is produced. No partial event should be written.
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

    // Act
    setTimeout(() => controller.abort(), 10);
    await expect(
      handleDoctorWithChecks(
        { timeoutMs: 5000, externalSignal: controller.signal },
        ctx,
        [slow],
        () => makeStubProbes(),
      ),
    ).rejects.toThrow(/abort/i);

    // Assert: no event was written.
    expect(appendSpy).not.toHaveBeenCalled();
  });

  it('HandleDoctor_AbortSignalFired_RejectsWithAbortError', async () => {
    // Arrange: a check that awaits the signal to abort. The composer
    // exposes an `externalSignal` so the caller can cancel in-flight.
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
      // unreachable
      return {
        category: 'runtime',
        name: 'abort-target',
        status: 'Pass',
        message: 'unreachable',
        durationMs: 0,
      };
    };

    // Act: fire abort shortly after kickoff, expect the promise to reject.
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

// ─── Task 009 — verification-toolchain (13th check) dispatch-through ─────────

/**
 * A benign full-probe bundle so every REAL check in `ALL_CHECKS` reaches its
 * return statement (mirrors the roster characterization's identity scaffold).
 * We dispatch the genuine roster through `handleDoctorWithChecks` rather than
 * unit-calling the CheckFn — per-handler tests bypass dispatch and have masked
 * DOA-action bugs before; the 13th check must be reachable THROUGH the composer.
 */
function benignProbes(): DoctorProbes {
  const emptyEnvironments: AgentEnvironment[] = [];
  return {
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
      runIntegrityCheck: async (): Promise<IntegrityResult> => ({
        ok: 'skipped',
        reason: 'benign dispatch probe',
      }),
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
  it('HandleDoctorWithChecks_RosterIncludesVerificationToolchain_FifteenChecks', async () => {
    // Arrange — dispatch the REAL ALL_CHECKS through the composer.
    const ctx = fakeContext();

    // Act
    const result = await handleDoctorWithChecks(
      { timeoutMs: 5000 },
      ctx,
      ALL_CHECKS,
      () => benignProbes(),
    );

    // Assert — the roster ships exactly 18 checks now (Task 017 added
    // onramp-block-drift + retired-hooks-present; Task 011 added stale-skill-dirs;
    // Task 019 added store-path-divergence; P05-04 added install-freshness), and
    // verification-toolchain is present (by category + name) in the dispatched
    // output, not just the export.
    expect(ALL_CHECKS).toHaveLength(18);
    expect(result.success).toBe(true);
    const data = result.data as { checks: CheckResult[] };
    expect(data.checks).toHaveLength(18);

    const vt = data.checks.find((c) => c.name === 'verification-toolchain');
    expect(vt).toBeDefined();
    expect(vt!.category).toBe('verification');
    // Reached through the composer with the benign full-triple probe → Pass,
    // and the six policy cells survive the DoctorOutputSchema.parse round-trip.
    expect(vt!.status).toBe('Pass');
    expect(vt!.policyCells).toHaveLength(6);
  });

  // ── Fold-in (Task 017): the DR-5 drift finding is REGISTERED in the roster ──
  it('HandleDoctorWithChecks_RosterIncludesBlockDriftAndRetiredHooks', async () => {
    // The Task 013 drift check (`checkBlockDrift`) was implemented + tested but
    // left UNREGISTERED, so DR-5's finding never fired in production. This pins
    // that BOTH the drift check and the retired-hooks uninstall-reachability check
    // reach the dispatched output through the composer (not just the static list).
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

    // The drift check keys off the `agent` category (its diff step is `generate`).
    const drift = data.checks.find((c) => c.name === 'onramp-block-drift');
    expect(drift!.category).toBe('agent');
    // And it appears BEFORE the retired-hooks removal check, so the block-write
    // step is ordered before the hook-removal step in any derived plan.
    expect(names.indexOf('onramp-block-drift')).toBeLessThan(
      names.indexOf('retired-hooks-present'),
    );
  });
});
