// Tests for the index.lock retry in `git-retry.ts`. Each timing seam is a
// deterministic fake, with no real timer and no `Math.random()`, so the tests
// assert the exact retry sequence. The result adapters apply the same backoff
// to executors that return a failure (`exitCode !== 0`) instead of throwing.

import { describe, it, expect, vi } from 'vitest';
import {
  withIndexLockRetry,
  withIndexLockRetryResult,
  withIndexLockRetrySync,
  burstStaggerDelayMs,
  burstStagger,
  IndexLockContentionError,
  extractLockPath,
  extractLockPathFromResult,
  isIndexLockError,
  isIndexLockResult,
  MAX_INDEX_LOCK_RETRIES,
  INDEX_LOCK_BASE_DELAY_MS,
  BURST_STAGGER_MIN_MS,
  BURST_STAGGER_MAX_MS,
  type GitExecLikeResult,
} from '../../../../src/verbs/worktree/git-retry.js';

/** A git lock failure for the given lock path. */
function lockError(lockPath: string): Error {
  return new Error(`fatal: Unable to create '${lockPath}': File exists.`);
}

const LOCK_PATH = '/tmp/repo/.git/index.lock';

/** Zero jitter, so each delay equals its base value. */
const zeroJitter = () => 0;
/** A sleep that records each delay and does not wait. */
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
  /**
   * One lock failure, then success. The wrapper must retry once after one base
   * backoff and return the value without the lock error.
   */
  it('GitRetry_TransientIndexLock_RetriesWithBackoffAndSucceeds', async () => {
    let calls = 0;
    const { sleep, calls: slept } = recordingSleep();
    const op = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw lockError(LOCK_PATH);
      return 'merged-sha';
    });

    const result = await withIndexLockRetry(op, { sleep, jitter: zeroJitter });

    expect(result).toBe('merged-sha');
    expect(op).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([INDEX_LOCK_BASE_DELAY_MS]);
  });

  /**
   * The first three attempts fail, so all three retries run. With zero jitter
   * the delays are `[200, 400, 800]`, and `onRetry` sees 1-based attempts. A
   * jitter of +1 multiplies each delay by 1.25.
   */
  it('GitRetry_InjectedSeam_AssertsDeterministicRetrySequence', async () => {
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
    expect(MAX_INDEX_LOCK_RETRIES).toBe(3);
    expect(slept).toEqual([200, 400, 800]);
    expect(onRetryInfo).toEqual([
      { attempt: 1, delayMs: 200, lockPath: LOCK_PATH },
      { attempt: 2, delayMs: 400, lockPath: LOCK_PATH },
      { attempt: 3, delayMs: 800, lockPath: LOCK_PATH },
    ]);

    const persistent = async () => {
      throw lockError(LOCK_PATH);
    };
    const { sleep: jitterSleep, calls: jitterSlept } = recordingSleep();
    await expect(
      withIndexLockRetry(persistent, { sleep: jitterSleep, jitter: () => 1 }),
    ).rejects.toBeInstanceOf(IndexLockContentionError);
    expect(jitterSlept).toEqual([250, 500, 1000]);
  });

  /**
   * The burst stagger stays in `[100, 500]` ms: the midpoint at jitter 0 and
   * the edges at -1 and +1. Jitter outside that range is clamped.
   * `burstStagger` sleeps the computed delay and returns it.
   */
  it('GitRetry_BurstCreationJitter_AssertedDeterministically', async () => {
    expect(burstStaggerDelayMs(() => 0)).toBe(300);
    expect(burstStaggerDelayMs(() => 1)).toBe(BURST_STAGGER_MAX_MS);
    expect(burstStaggerDelayMs(() => -1)).toBe(BURST_STAGGER_MIN_MS);
    expect(burstStaggerDelayMs(() => 0.5)).toBe(400);
    expect(burstStaggerDelayMs(() => 5)).toBe(BURST_STAGGER_MAX_MS);
    expect(burstStaggerDelayMs(() => -5)).toBe(BURST_STAGGER_MIN_MS);

    const { sleep, calls: slept } = recordingSleep();
    const applied = await burstStagger({ sleep, jitter: () => 0 });
    expect(applied).toBe(300);
    expect(slept).toEqual([300]);
  });

  /**
   * Persistent contention uses all retries. The wrapper must throw
   * `IndexLockContentionError` with the lock path and the attempt count. It
   * must not resolve and hide the failure.
   */
  it('GitRetry_ExhaustedRetries_ReturnsStructuredErrorNotSilentNoOp', async () => {
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
    expect(structured.attempts).toBe(MAX_INDEX_LOCK_RETRIES + 1);
    expect(structured.maxRetries).toBe(MAX_INDEX_LOCK_RETRIES);
    expect(structured.delaysMs).toEqual([200, 400, 800]);
    expect(structured.lastError).toBeInstanceOf(Error);
    expect(op).toHaveBeenCalledTimes(MAX_INDEX_LOCK_RETRIES + 1);
    expect(slept).toEqual([200, 400, 800]);
  });

  /** A failure that is not a lock error rethrows unchanged on the first attempt, with no sleep. */
  it('GitRetry_NonLockError_RethrowsImmediatelyWithoutRetry', async () => {
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

  /** A runner result with a `stderr` field also matches. */
  it('extractLockPath / isIndexLockError recognize the git signature', () => {
    expect(extractLockPath(lockError(LOCK_PATH))).toBe(LOCK_PATH);
    expect(isIndexLockError(lockError(LOCK_PATH))).toBe(true);
    expect(isIndexLockError({ status: 128, stderr: `Unable to create '${LOCK_PATH}': File exists.` })).toBe(true);
    expect(extractLockPath(new Error('some other failure'))).toBeUndefined();
    expect(isIndexLockError('plain string, no lock')).toBe(false);
  });
});

/** A git runner result with a lock failure message. */
function lockResult(lockPath: string): GitExecLikeResult {
  return {
    exitCode: 128,
    stderr: `fatal: Unable to create '${lockPath}': File exists.`,
    stdout: '',
  };
}
const okResult: GitExecLikeResult = { exitCode: 0, stdout: 'merged-sha', stderr: '' };

/** A synchronous sleep that records each delay and does not block. */
function recordingSyncSleep(): { sleep: (ms: number) => void; calls: number[] } {
  const calls: number[] = [];
  return { calls, sleep: (ms: number) => void calls.push(ms) };
}

describe('git-retry — result-aware predicate (DR-1)', () => {
  /** An exit code of 0 is never contention, even when the output names a lock file. */
  it('isIndexLockResult / extractLockPathFromResult gate on exitCode !== 0', () => {
    expect(isIndexLockResult(lockResult(LOCK_PATH))).toBe(true);
    expect(extractLockPathFromResult(lockResult(LOCK_PATH))).toBe(LOCK_PATH);
    expect(
      isIndexLockResult({ exitCode: 0, stdout: `touched ${LOCK_PATH}`, stderr: '' }),
    ).toBe(false);
    expect(extractLockPathFromResult({ exitCode: 0, stdout: LOCK_PATH })).toBeUndefined();
    expect(isIndexLockResult({ exitCode: 1, stderr: 'merge conflict' })).toBe(false);
  });
});

describe('git-retry — withIndexLockRetrySync (DR-1)', () => {
  /** Two lock results, then success, so two backoffs run before the third attempt. */
  it('WithIndexLockRetrySync_ContentionResult_RetriesWithBackoffThenSucceeds', () => {
    const { sleep, calls: slept } = recordingSyncSleep();
    let calls = 0;
    const op = vi.fn((): GitExecLikeResult => {
      calls += 1;
      return calls <= 2 ? lockResult(LOCK_PATH) : okResult;
    });

    const result = withIndexLockRetrySync(op, { sleep, jitter: zeroJitter });

    expect(result).toBe(okResult);
    expect(result.exitCode).toBe(0);
    expect(op).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([200, 400]);
  });

  /**
   * Persistent contention uses all retries. The sync adapter must return the
   * last contention result and not throw, because a synchronous `GitExec`
   * does not throw.
   */
  it('WithIndexLockRetrySync_PersistentContention_ReturnsStructuredResultNotThrow', () => {
    const { sleep, calls: slept } = recordingSyncSleep();
    const op = vi.fn((): GitExecLikeResult => lockResult(LOCK_PATH));

    const result = withIndexLockRetrySync(op, { sleep, jitter: zeroJitter });

    expect(result.exitCode).toBe(128);
    expect(isIndexLockResult(result)).toBe(true);
    expect(op).toHaveBeenCalledTimes(MAX_INDEX_LOCK_RETRIES + 1);
    expect(slept).toEqual([200, 400, 800]);
  });

  it('WithIndexLockRetrySync_NonLockFailure_ReturnsImmediatelyWithoutRetry', () => {
    const { sleep, calls: slept } = recordingSyncSleep();
    const failure: GitExecLikeResult = { exitCode: 1, stderr: 'merge conflict', stdout: '' };
    const op = vi.fn((): GitExecLikeResult => failure);

    const result = withIndexLockRetrySync(op, { sleep, jitter: zeroJitter });

    expect(result).toBe(failure);
    expect(op).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });
});

describe('git-retry — withIndexLockRetryResult (DR-1)', () => {
  it('WithIndexLockRetryResult_ContentionResult_RetriesThenSucceeds', async () => {
    const { sleep, calls: slept } = recordingSleep();
    let calls = 0;
    const op = vi.fn(async (): Promise<GitExecLikeResult> => {
      calls += 1;
      return calls === 1 ? lockResult(LOCK_PATH) : okResult;
    });

    const result = await withIndexLockRetryResult(op, { sleep, jitter: zeroJitter });

    expect(result).toBe(okResult);
    expect(op).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([INDEX_LOCK_BASE_DELAY_MS]);
  });

  /** Persistent contention returns the last contention result and does not throw. */
  it('WithIndexLockRetryResult_PersistentContention_ReturnsStructuredResultNotThrow', async () => {
    const { sleep, calls: slept } = recordingSleep();
    const op = vi.fn(async (): Promise<GitExecLikeResult> => lockResult(LOCK_PATH));

    const result = await withIndexLockRetryResult(op, { sleep, jitter: zeroJitter });

    expect(result.exitCode).toBe(128);
    expect(isIndexLockResult(result)).toBe(true);
    expect(op).toHaveBeenCalledTimes(MAX_INDEX_LOCK_RETRIES + 1);
    expect(slept).toEqual([200, 400, 800]);
  });
});
