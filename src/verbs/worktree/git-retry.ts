/**
 * A bounded retry for git lock contention, and a stagger for burst dispatch.
 *
 * Under burst dispatch, a git command that changes a worktree can lose the
 * race for `.git/index.lock`. The holder releases the lock within
 * milliseconds, so a bounded retry with backoff clears the contention.
 *
 * The sleep, the jitter source, and the backoff values are injected. The real
 * `Math.random()` and `setTimeout` calls are only in the exported defaults, so
 * tests can assert the exact retry sequence.
 */

/**
 * The injected delay function, called with a delay in ms. Tests replace it to
 * skip the real wait. Other wait loops reuse it.
 */
export type SleepFn = (ms: number) => Promise<void>;

/** The real sleep over `setTimeout`. It is the only `setTimeout` call in this module. */
export const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The injected jitter source. It returns a signed fraction in `[-1, 1]`. The
 * backoff delay is `base * (1 + jitterFraction * jitter())`.
 */
export type JitterFn = () => number;

/**
 * The real jitter: `Math.random()` mapped to a uniform fraction in `[-1, 1]`.
 * It is the only real random source in this module.
 */
export const defaultJitter: JitterFn = () => Math.random() * 2 - 1;

/** Base backoff delay (ms) before the first retry. */
export const INDEX_LOCK_BASE_DELAY_MS = 200;
/** Exponential growth factor applied per retry: `base * factor^attempt`. */
export const INDEX_LOCK_BACKOFF_FACTOR = 2.0;
/** Symmetric jitter band as a fraction of the computed delay (±25%). */
export const INDEX_LOCK_JITTER_FRACTION = 0.25;
/**
 * The retries after the first attempt, so `MAX_INDEX_LOCK_RETRIES + 1`
 * attempts in total. With the defaults, the backoff without jitter is
 * `[200, 400, 800]` ms.
 */
export const MAX_INDEX_LOCK_RETRIES = 3;

/** Lower bound (ms) of the burst-creation stagger band. */
export const BURST_STAGGER_MIN_MS = 100;
/** Upper bound (ms) of the burst-creation stagger band. */
export const BURST_STAGGER_MAX_MS = 500;

/**
 * The git lock failure message: `fatal: Unable to create '<path>.lock': File exists.`
 * The capture group is the lock path. The pattern matches `index.lock` and each
 * other `*.lock`, such as `HEAD.lock` and `packed-refs.lock`.
 */
const INDEX_LOCK_SIGNATURE = /unable to create '([^']*\.lock)'/i;

/**
 * Gets the text of an error. For an object, it joins the `message`, `stderr`,
 * and `stdout` strings, so the signature also matches a git runner result.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const parts = [rec.message, rec.stderr, rec.stdout].filter(
      (v): v is string => typeof v === 'string',
    );
    if (parts.length > 0) return parts.join('\n');
  }
  return String(err);
}

/**
 * Extract the contended lock-file path from a git lock-creation failure, or
 * `undefined` when `err` is not a recognizable lock-contention error.
 */
export function extractLockPath(err: unknown): string | undefined {
  const match = INDEX_LOCK_SIGNATURE.exec(errorMessage(err));
  return match?.[1];
}

/** True when `err` is a transient git `index.lock`-family contention error. */
export function isIndexLockError(err: unknown): boolean {
  return extractLockPath(err) !== undefined;
}

/**
 * The minimal result shape of a git executor that reports failures through
 * `exitCode` and does not throw. The type is structural, so this module does
 * not depend on `GitExecResult` in `pure/merge-preflight.ts`.
 */
export interface GitExecLikeResult {
  /** Process exit code — non-zero signals a git failure. */
  readonly exitCode: number;
  /** Captured stderr (git writes its lock-contention message here). */
  readonly stderr?: string;
  /**
   * Captured stdout. `defaultGitExec` folds stderr into stdout on failure, so
   * the signature match reads both channels.
   */
  readonly stdout?: string;
}

/**
 * Returns the lock path from a failed git executor result, or `undefined`.
 * A result with `exitCode` 0 always returns `undefined`, so a successful
 * command that mentions a `*.lock` path is not contention.
 */
export function extractLockPathFromResult(result: GitExecLikeResult): string | undefined {
  if (result.exitCode === 0) return undefined;
  return extractLockPath(result);
}

/** True when a git executor result failed with the lock signature. */
export function isIndexLockResult(result: GitExecLikeResult): boolean {
  return extractLockPathFromResult(result) !== undefined;
}

/** Diagnostics carried by {@link IndexLockContentionError}. */
export interface IndexLockRetryDiagnostics {
  /** The contended lock-file path git refused to create. */
  readonly lockPath: string;
  /** Total attempts made (initial + retries). */
  readonly attempts: number;
  /** The configured retry budget (`attempts === maxRetries + 1` on exhaustion). */
  readonly maxRetries: number;
  /** The actual backoff delays slept, in order (post-jitter, rounded ms). */
  readonly delaysMs: readonly number[];
}

/**
 * Thrown when the retry budget runs out and the lock contention did not clear.
 * It holds the lock path and the attempt count, and `lastError` holds the
 * last error.
 */
export class IndexLockContentionError extends Error {
  readonly code = 'INDEX_LOCK_CONTENTION' as const;
  readonly lockPath: string;
  readonly attempts: number;
  readonly maxRetries: number;
  readonly delaysMs: readonly number[];
  readonly lastError: unknown;

  constructor(diagnostics: IndexLockRetryDiagnostics, lastError: unknown) {
    super(
      `git index lock contention unresolved after ${diagnostics.attempts} attempt(s): ${diagnostics.lockPath}`,
    );
    this.name = 'IndexLockContentionError';
    this.lockPath = diagnostics.lockPath;
    this.attempts = diagnostics.attempts;
    this.maxRetries = diagnostics.maxRetries;
    this.delaysMs = diagnostics.delaysMs;
    this.lastError = lastError;
  }
}

/**
 * The backoff delay after the failed 0-based `attempt`. The base delay is
 * `baseDelayMs * backoffFactor^attempt`. The jitter keeps the multiplier in
 * `[1 - jitterFraction, 1 + jitterFraction]`. All three retry wrappers use this
 * function, so they produce the same sequence.
 */
function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  backoffFactor: number,
  jitterFraction: number,
  jitter: JitterFn,
): number {
  const baseDelay = baseDelayMs * backoffFactor ** attempt;
  return Math.max(0, Math.round(baseDelay * (1 + jitterFraction * jitter())));
}

/** Options for {@link withIndexLockRetry}. All timing seams are injectable. */
export interface IndexLockRetryOptions {
  /** Injected sleep seam. Defaults to {@link defaultSleep}. */
  readonly sleep?: SleepFn;
  /** Injected signed-jitter source in `[-1, 1]`. Defaults to {@link defaultJitter}. */
  readonly jitter?: JitterFn;
  /** Retries after the initial attempt. Defaults to {@link MAX_INDEX_LOCK_RETRIES}. */
  readonly maxRetries?: number;
  /** Base backoff (ms). Defaults to {@link INDEX_LOCK_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number;
  /** Exponential factor. Defaults to {@link INDEX_LOCK_BACKOFF_FACTOR}. */
  readonly backoffFactor?: number;
  /** Symmetric jitter fraction. Defaults to {@link INDEX_LOCK_JITTER_FRACTION}. */
  readonly jitterFraction?: number;
  /**
   * Called once for each retry, before the backoff sleep, so a caller can emit
   * an audit record. `attempt` starts at 1. `delayMs` is the next backoff.
   */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    lockPath: string;
  }) => void | Promise<void>;
}

/**
 * Runs a git operation and retries it only when it throws a lock contention
 * error. Any other error goes back to the caller unchanged, with no retry.
 * When the retry budget runs out, the function throws an
 * {@link IndexLockContentionError}.
 */
export async function withIndexLockRetry<T>(
  op: () => Promise<T> | T,
  options: IndexLockRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? defaultJitter;
  const maxRetries = options.maxRetries ?? MAX_INDEX_LOCK_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? INDEX_LOCK_BASE_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? INDEX_LOCK_BACKOFF_FACTOR;
  const jitterFraction = options.jitterFraction ?? INDEX_LOCK_JITTER_FRACTION;

  let lastError: unknown;
  let lastLockPath = '';
  const delaysMs: number[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      const lockPath = extractLockPath(err);
      if (lockPath === undefined) {
        throw err;
      }
      lastLockPath = lockPath;

      const retriesRemain = attempt < maxRetries;
      if (!retriesRemain) {
        break;
      }

      const delayMs = computeBackoffDelayMs(
        attempt,
        baseDelayMs,
        backoffFactor,
        jitterFraction,
        jitter,
      );
      delaysMs.push(delayMs);
      if (options.onRetry) {
        await options.onRetry({ attempt: attempt + 1, delayMs, lockPath });
      }
      await sleep(delayMs);
    }
  }

  throw new IndexLockContentionError(
    {
      lockPath: lastLockPath,
      attempts: maxRetries + 1,
      maxRetries,
      delaysMs,
    },
    lastError,
  );
}

/**
 * The async variant of {@link withIndexLockRetry} for an executor that returns
 * its failures and does not throw. It retries while {@link isIndexLockResult}
 * is true. A success or another failure returns at once. When the budget runs
 * out, it returns the last contention result and does not throw.
 */
export async function withIndexLockRetryResult<R extends GitExecLikeResult>(
  op: () => Promise<R> | R,
  options: IndexLockRetryOptions = {},
): Promise<R> {
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? defaultJitter;
  const maxRetries = options.maxRetries ?? MAX_INDEX_LOCK_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? INDEX_LOCK_BASE_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? INDEX_LOCK_BACKOFF_FACTOR;
  const jitterFraction = options.jitterFraction ?? INDEX_LOCK_JITTER_FRACTION;

  for (let attempt = 0; ; attempt += 1) {
    const result = await op();
    const lockPath = extractLockPathFromResult(result);
    if (lockPath === undefined || attempt >= maxRetries) {
      return result;
    }
    const delayMs = computeBackoffDelayMs(
      attempt,
      baseDelayMs,
      backoffFactor,
      jitterFraction,
      jitter,
    );
    if (options.onRetry) {
      await options.onRetry({ attempt: attempt + 1, delayMs, lockPath });
    }
    await sleep(delayMs);
  }
}

/**
 * The synchronous counterpart of {@link SleepFn}. {@link withIndexLockRetrySync}
 * wraps a synchronous `GitExec` and cannot `await`.
 */
export type SyncSleepFn = (ms: number) => void;

/**
 * The real synchronous sleep. It blocks the thread for `ms` with `Atomics.wait`
 * on a new `SharedArrayBuffer`, with no busy loop. With the default values and
 * no jitter, the retries block for 1.4 seconds in total.
 */
export const defaultSyncSleep: SyncSleepFn = (ms) => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Options for {@link withIndexLockRetrySync}. They match
 * {@link IndexLockRetryOptions}, with a synchronous sleep and `onRetry`.
 */
export interface IndexLockRetrySyncOptions {
  /** Injected synchronous sleep seam. Defaults to {@link defaultSyncSleep}. */
  readonly sleep?: SyncSleepFn;
  /** Injected signed-jitter source in `[-1, 1]`. Defaults to {@link defaultJitter}. */
  readonly jitter?: JitterFn;
  /** Retries after the initial attempt. Defaults to {@link MAX_INDEX_LOCK_RETRIES}. */
  readonly maxRetries?: number;
  /** Base backoff (ms). Defaults to {@link INDEX_LOCK_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number;
  /** Exponential factor. Defaults to {@link INDEX_LOCK_BACKOFF_FACTOR}. */
  readonly backoffFactor?: number;
  /** Symmetric jitter fraction. Defaults to {@link INDEX_LOCK_JITTER_FRACTION}. */
  readonly jitterFraction?: number;
  /** Called once for each retry, before the blocking backoff sleep. */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    lockPath: string;
  }) => void;
}

/**
 * The synchronous variant of {@link withIndexLockRetry} for a synchronous
 * `GitExec`. `GitExec` reports failures through `exitCode` and does not throw,
 * so the retry keys on {@link isIndexLockResult}. It sleeps synchronously
 * between attempts. When the budget runs out, it returns the last contention
 * result and does not throw.
 */
export function withIndexLockRetrySync<R extends GitExecLikeResult>(
  op: () => R,
  options: IndexLockRetrySyncOptions = {},
): R {
  const sleep = options.sleep ?? defaultSyncSleep;
  const jitter = options.jitter ?? defaultJitter;
  const maxRetries = options.maxRetries ?? MAX_INDEX_LOCK_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? INDEX_LOCK_BASE_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? INDEX_LOCK_BACKOFF_FACTOR;
  const jitterFraction = options.jitterFraction ?? INDEX_LOCK_JITTER_FRACTION;

  for (let attempt = 0; ; attempt += 1) {
    const result = op();
    const lockPath = extractLockPathFromResult(result);
    if (lockPath === undefined || attempt >= maxRetries) {
      return result;
    }
    const delayMs = computeBackoffDelayMs(
      attempt,
      baseDelayMs,
      backoffFactor,
      jitterFraction,
      jitter,
    );
    options.onRetry?.({ attempt: attempt + 1, delayMs, lockPath });
    sleep(delayMs);
  }
}

/**
 * Computes a stagger delay in `[minMs, maxMs]` from a jitter value in
 * `[-1, 1]`. A jitter of 0 gives the midpoint, 1 gives `maxMs`, and -1 gives
 * `minMs`. The result is clamped to the band, so a bad jitter source cannot
 * leave it.
 */
export function burstStaggerDelayMs(
  jitter: JitterFn = defaultJitter,
  minMs: number = BURST_STAGGER_MIN_MS,
  maxMs: number = BURST_STAGGER_MAX_MS,
): number {
  const mid = (minMs + maxMs) / 2;
  const halfBand = (maxMs - minMs) / 2;
  const raw = mid + halfBand * jitter();
  return Math.max(minMs, Math.min(maxMs, Math.round(raw)));
}

/**
 * Sleeps for a jittered delay, by default 100 to 500 ms, before a worktree
 * creation or adoption under burst dispatch. It returns the delay that it
 * applied.
 */
export async function burstStagger(
  options: {
    readonly sleep?: SleepFn | undefined;
    readonly jitter?: JitterFn | undefined;
    readonly minMs?: number | undefined;
    readonly maxMs?: number | undefined;
  } = {},
): Promise<number> {
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = burstStaggerDelayMs(
    options.jitter ?? defaultJitter,
    options.minMs ?? BURST_STAGGER_MIN_MS,
    options.maxMs ?? BURST_STAGGER_MAX_MS,
  );
  await sleep(delayMs);
  return delayMs;
}
