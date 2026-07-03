// ─── git-retry tests (DR-8) ─────────────────────────────────────────────────
//
// MEDIUM-tier unit suite over the fully-injected backoff/jitter/sleep seam.
// Every timing seam is replaced with a deterministic fake (no real timers, no
// real `Math.random()`), so the retry sequence is asserted EXACTLY. The four
// named tests pin DR-8's acceptance criteria:
//   • transient lock → retries → succeeds without surfacing the error
//   • injected seam → exact backoff sequence [200,400,800] (modulo jitter)
//   • burst-creation jitter → bounded + deterministic under injection
//   • exhausted retries → structured error (lock path + attempts), not a no-op
// ───────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  withIndexLockRetry,
  burstStaggerDelayMs,
  burstStagger,
  IndexLockContentionError,
  extractLockPath,
  isIndexLockError,
  MAX_INDEX_LOCK_RETRIES,
  INDEX_LOCK_BASE_DELAY_MS,
  BURST_STAGGER_MIN_MS,
  BURST_STAGGER_MAX_MS,
} from './git-retry.js';

// A realistic git lock-creation failure for a given lock path.
function lockError(lockPath: string): Error {
  return new Error(`fatal: Unable to create '${lockPath}': File exists.`);
}

const LOCK_PATH = '/tmp/repo/.git/index.lock';

// Deterministic seams: zero jitter → delay == base; recording sleep → no wait.
const zeroJitter = () => 0;
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

describe('git-retry — index.lock contention resilience (DR-8)', () => {
  it('GitRetry_TransientIndexLock_RetriesWithBackoffAndSucceeds', async () => {
    // One transient index.lock failure, then success. The wrapper must retry
    // and return the operation's value WITHOUT surfacing the lock error.
    let calls = 0;
    const { sleep, calls: slept } = recordingSleep();
    const op = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw lockError(LOCK_PATH);
      return 'merged-sha';
    });

    const result = await withIndexLockRetry(op, { sleep, jitter: zeroJitter });

    expect(result).toBe('merged-sha');
    expect(op).toHaveBeenCalledTimes(2); // initial fail + one successful retry
    expect(slept).toEqual([INDEX_LOCK_BASE_DELAY_MS]); // exactly one backoff: 200ms
  });

  it('GitRetry_InjectedSeam_AssertsDeterministicRetrySequence', async () => {
    // With injected sleep/jitter the exact backoff sequence is asserted. Fail
    // on the first three attempts (the lock clears on the fourth) so all three
    // configured retries fire and their delays are observed in order.
    const { sleep, calls: slept } = recordingSleep();
    const onRetryInfo: Array<{ attempt: number; delayMs: number; lockPath: string }> = [];
    let calls = 0;
    const op = async () => {
      calls += 1;
      if (calls <= 3) throw lockError(LOCK_PATH);
      return 'ok';
    };

    const result = await withIndexLockRetry(op, {
      sleep,
      jitter: zeroJitter,
      onRetry: (info) => {
        onRetryInfo.push(info);
      },
    });

    expect(result).toBe('ok');
    // Default budget is 3 retries → zero-jitter backoff sequence [200,400,800].
    expect(MAX_INDEX_LOCK_RETRIES).toBe(3);
    expect(slept).toEqual([200, 400, 800]);
    // The audit hook sees the same sequence with 1-based ordinals + lock path.
    expect(onRetryInfo).toEqual([
      { attempt: 1, delayMs: 200, lockPath: LOCK_PATH },
      { attempt: 2, delayMs: 400, lockPath: LOCK_PATH },
      { attempt: 3, delayMs: 800, lockPath: LOCK_PATH },
    ]);

    // "modulo injected jitter": a non-zero signed jitter feeds the multiplier
    // `base * (1 + 0.25 * jitter())`. jitter = +1 → ×1.25 → [250,500,1000].
    const persistent = async () => {
      throw lockError(LOCK_PATH);
    };
    const { sleep: jitterSleep, calls: jitterSlept } = recordingSleep();
    await expect(
      withIndexLockRetry(persistent, { sleep: jitterSleep, jitter: () => 1 }),
    ).rejects.toBeInstanceOf(IndexLockContentionError);
    expect(jitterSlept).toEqual([250, 500, 1000]);
  });

  it('GitRetry_BurstCreationJitter_AssertedDeterministically', async () => {
    // Burst-creation jitter is bounded to [100,500] and deterministic under an
    // injected jitter source: midpoint at 0, the band edges at ±1, clamped
    // beyond ±1 so a misbehaving source can never escape the band.
    expect(burstStaggerDelayMs(() => 0)).toBe(300); // midpoint of [100,500]
    expect(burstStaggerDelayMs(() => 1)).toBe(BURST_STAGGER_MAX_MS); // 500
    expect(burstStaggerDelayMs(() => -1)).toBe(BURST_STAGGER_MIN_MS); // 100
    expect(burstStaggerDelayMs(() => 0.5)).toBe(400);
    // Out-of-band jitter is clamped, never surfaced.
    expect(burstStaggerDelayMs(() => 5)).toBe(BURST_STAGGER_MAX_MS);
    expect(burstStaggerDelayMs(() => -5)).toBe(BURST_STAGGER_MIN_MS);

    // burstStagger sleeps the computed (injected, deterministic) delay and
    // returns it — both jitter and sleep are injected, no real timer fires.
    const { sleep, calls: slept } = recordingSleep();
    const applied = await burstStagger({ sleep, jitter: () => 0 });
    expect(applied).toBe(300);
    expect(slept).toEqual([300]);
  });

  it('GitRetry_ExhaustedRetries_ReturnsStructuredErrorNotSilentNoOp', async () => {
    // A persistent index.lock contention exhausts the budget. The wrapper MUST
    // surface a structured error carrying the lock path + attempt count — never
    // a silent no-op (which would return undefined and swallow the failure).
    const { sleep, calls: slept } = recordingSleep();
    const op = vi.fn(async () => {
      throw lockError(LOCK_PATH);
    });

    const caught = await withIndexLockRetry(op, { sleep, jitter: zeroJitter }).then(
      () => {
        throw new Error('expected withIndexLockRetry to throw, but it resolved');
      },
      (err: unknown) => err,
    );

    expect(caught).toBeInstanceOf(IndexLockContentionError);
    const structured = caught as IndexLockContentionError;
    expect(structured.code).toBe('INDEX_LOCK_CONTENTION');
    expect(structured.lockPath).toBe(LOCK_PATH);
    expect(structured.attempts).toBe(MAX_INDEX_LOCK_RETRIES + 1); // 4 total
    expect(structured.maxRetries).toBe(MAX_INDEX_LOCK_RETRIES);
    expect(structured.delaysMs).toEqual([200, 400, 800]);
    expect(structured.lastError).toBeInstanceOf(Error);
    // Not a no-op: the op was actually attempted 1 + N times, and every retry
    // backed off.
    expect(op).toHaveBeenCalledTimes(MAX_INDEX_LOCK_RETRIES + 1);
    expect(slept).toEqual([200, 400, 800]);
  });

  it('GitRetry_NonLockError_RethrowsImmediatelyWithoutRetry', async () => {
    // A non-lock failure is NOT our concern: rethrow on the first attempt with
    // zero retries / zero sleeps, surfacing the original error unchanged.
    const { sleep, calls: slept } = recordingSleep();
    const original = new Error('fatal: merge conflict in src/foo.ts');
    const op = vi.fn(async () => {
      throw original;
    });

    await expect(
      withIndexLockRetry(op, { sleep, jitter: zeroJitter }),
    ).rejects.toBe(original);
    expect(op).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('extractLockPath / isIndexLockError recognize the git signature', () => {
    expect(extractLockPath(lockError(LOCK_PATH))).toBe(LOCK_PATH);
    expect(isIndexLockError(lockError(LOCK_PATH))).toBe(true);
    // Non-throwing git-runner result shape ({ stderr }) is also recognized.
    expect(isIndexLockError({ status: 128, stderr: `Unable to create '${LOCK_PATH}': File exists.` })).toBe(true);
    expect(extractLockPath(new Error('some other failure'))).toBeUndefined();
    expect(isIndexLockError('plain string, no lock')).toBe(false);
  });
});
