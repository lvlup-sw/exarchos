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
import type { CheckResult } from './schema.js';
import { handleDoctorWithChecks } from './index.js';

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
