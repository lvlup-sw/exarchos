// ─── git-retry — index.lock contention resilience + burst stagger (DR-8) ────
//
// DR-8 (git-mutation lock-contention resilience). Worktree-mutating git
// operations the manager performs (e.g. `git worktree add`, `git merge`,
// `git checkout`) can transiently lose a race for `.git/index.lock` under
// burst dispatch — git surfaces this as
// `fatal: Unable to create '<path>/index.lock': File exists.`. That contention
// is *transient*: the holder releases the lock within milliseconds, so a
// bounded retry-with-backoff resolves it without surfacing the error.
//
// The whole seam — backoff base, jitter source, AND the sleep delay — is
// INJECTED (mirroring the bounded timeout-retry seam in
// `orchestrate/pure/execute-merge.ts`, the canonical reference for this shape).
// The testable core (`withIndexLockRetry`, `burstStaggerDelayMs`) calls NO real
// `Math.random()` and NO real timers when the seams are injected, so the retry
// sequence is asserted deterministically (workflow-determinism invariant). The
// real `Math.random()` jitter and `setTimeout` sleep live ONLY in the exported
// defaults, which production leaves in place and tests replace.
//
// The `SleepFn` seam (and `defaultSleep`) is exported deliberately so the
// bounded `wait` (Task 004) and the merge wait-for-slot loop (Task 006) reuse
// ONE timing seam rather than each re-deriving a `setTimeout` promise.
// ───────────────────────────────────────────────────────────────────────────

// ─── Injected seams (exported for reuse across the WLM operational core) ─────

/**
 * Injected delay seam — invoked with a computed delay (ms). Injected so tests
 * skip the real wall-clock wait and so other WLM tasks (004 bounded `wait`,
 * 006 merge wait-for-slot) reuse a single timing seam. Defaults to a real
 * `setTimeout`-based sleep.
 */
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Default real sleep over `setTimeout`. The ONLY place a real timer is
 * created in this module — every testable code path accepts an injected
 * `SleepFn` and never reaches this default under test.
 */
export const defaultSleep: SleepFn = (ms) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Injected jitter source. Returns a signed fraction in `[-1, 1]`; the effective
 * backoff delay is `base * (1 + jitterFraction * jitter())`. Injected rather
 * than an inline `Math.random()` so the retry path stays deterministic under
 * test.
 */
export type JitterFn = () => number;

/**
 * Default real jitter over `Math.random()` mapped to a uniform signed fraction
 * in `[-1, 1]`. The ONLY place real randomness is read in this module — every
 * testable code path accepts an injected `JitterFn`.
 */
export const defaultJitter: JitterFn = () => Math.random() * 2 - 1;

// ─── index.lock retry tuning ────────────────────────────────────────────────

/** Base backoff delay (ms) before the first retry. */
export const INDEX_LOCK_BASE_DELAY_MS = 200;
/** Exponential growth factor applied per retry: `base * factor^attempt`. */
export const INDEX_LOCK_BACKOFF_FACTOR = 2.0;
/** Symmetric jitter band as a fraction of the computed delay (±25%). */
export const INDEX_LOCK_JITTER_FRACTION = 0.25;
/**
 * Max retries after the initial attempt → `MAX_INDEX_LOCK_RETRIES + 1` total
 * attempts. With the defaults above the zero-jitter backoff sequence is
 * `[200, 400, 800]` ms (DR-8 "~200/400/800ms ±jitter").
 */
export const MAX_INDEX_LOCK_RETRIES = 3;

// ─── Burst-creation stagger tuning ──────────────────────────────────────────

/** Lower bound (ms) of the burst-creation stagger band. */
export const BURST_STAGGER_MIN_MS = 100;
/** Upper bound (ms) of the burst-creation stagger band. */
export const BURST_STAGGER_MAX_MS = 500;

// ─── git lock-error signature ───────────────────────────────────────────────

/**
 * git's lock-creation failure message:
 *   `fatal: Unable to create '<path>.lock': File exists.`
 * Capture the lock-file path so the structured error can report exactly which
 * lock could not be acquired. Matches `index.lock` (DR-8's named case) and any
 * sibling `*.lock` (HEAD.lock, packed-refs.lock, …) so the same wrapper covers
 * every worktree-mutating git lock contention.
 */
const INDEX_LOCK_SIGNATURE = /unable to create '([^']*\.lock)'/i;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  // A git-runner result object surfacing `{ status, stdout, stderr }` — fold
  // any string-bearing fields so the signature still matches a non-throwing
  // runner that returns its diagnostics rather than throwing.
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

// ─── Result-aware lock detection (for non-throwing git executors) ────────────

/**
 * The minimal shape of a non-throwing git executor result the result-aware
 * adapters key off. Both the synchronous `GitExec` (`spawnSync`/`execFileSync`)
 * and any async executor that reports failures via `exitCode` (rather than
 * throwing) satisfy this. Kept structural so `git-retry` stays decoupled from
 * the concrete `GitExecResult` type in `pure/merge-preflight.ts`.
 */
export interface GitExecLikeResult {
  /** Process exit code — non-zero signals a git failure. */
  readonly exitCode: number;
  /** Captured stderr (git writes its lock-contention message here). */
  readonly stderr?: string;
  /**
   * Captured stdout. The canonical `defaultGitExec` folds stderr INTO stdout on
   * failure, so the signature is matched against both channels for robustness.
   */
  readonly stdout?: string;
}

/**
 * Extract the contended lock-file path from a NON-THROWING git executor result,
 * or `undefined` when the result is not a recognizable `index.lock` contention.
 *
 * Gated on `exitCode !== 0` FIRST (a successful command whose output merely
 * mentions a `*.lock` path must never be mistaken for contention), then matched
 * against the folded `stderr`/`stdout` via the shared {@link extractLockPath}
 * signature. This is the result-plane analogue of {@link extractLockPath}'s
 * throw-plane detection.
 */
export function extractLockPathFromResult(result: GitExecLikeResult): string | undefined {
  if (result.exitCode === 0) return undefined;
  return extractLockPath(result);
}

/**
 * True when a non-throwing git executor result is a transient `index.lock`-family
 * contention (`exitCode !== 0` AND the lock signature is present). The
 * result-plane analogue of {@link isIndexLockError}.
 */
export function isIndexLockResult(result: GitExecLikeResult): boolean {
  return extractLockPathFromResult(result) !== undefined;
}

// ─── Structured exhaustion error ────────────────────────────────────────────

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
 * Thrown when the bounded retry budget is exhausted and the `index.lock`
 * contention never cleared. Carries the lock path + attempt count so the
 * failure is a *structured* surface, never a silent no-op (DR-8 AC). The
 * underlying last error is preserved on `lastError`.
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

// ─── Backoff computation (shared by every retry adapter) ────────────────────

/**
 * Exponential backoff with bounded symmetric jitter for the given 0-based
 * `attempt` (the failed attempt whose backoff is being computed). The base
 * delay is `baseDelayMs * backoffFactor^attempt`; the injected `jitter` source
 * is signed in `[-1, 1]`, so the effective multiplier stays in
 * `[1 - jitterFraction, 1 + jitterFraction]` (> 0 for the default 0.25). Shared
 * by the throw-plane {@link withIndexLockRetry} and both result-plane adapters
 * so all three produce the identical DR-8 backoff sequence.
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

// ─── Retry wrapper ──────────────────────────────────────────────────────────

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
   * Invoked once per retry, BEFORE the backoff sleep, so a caller can emit an
   * audit record. `attempt` is the 1-based retry ordinal; `delayMs` is the
   * backoff about to be applied; `lockPath` is the contended lock file.
   */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    lockPath: string;
  }) => void | Promise<void>;
}

/**
 * Run a (possibly async) git operation, retrying ONLY on a transient
 * `index.lock`-family contention error with exponential backoff + bounded
 * jitter. A non-lock failure is rethrown immediately (never retried). On
 * success the operation's value is returned and no error is surfaced. When the
 * retry budget is exhausted, throws a structured {@link IndexLockContentionError}
 * carrying the lock path and attempt count — never a silent no-op (DR-8).
 *
 * Backoff, jitter, and sleep are all injected; with deterministic fakes the
 * exact retry sequence is assertable.
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

  // attempt index: 0 = initial, 1..maxRetries = retries.
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      const lockPath = extractLockPath(err);
      if (lockPath === undefined) {
        // Non-transient (not an index.lock contention) → not our concern.
        // Rethrow unchanged so the caller's own error handling runs.
        throw err;
      }
      lastLockPath = lockPath;

      const retriesRemain = attempt < maxRetries;
      if (!retriesRemain) {
        // Out of retry budget → exit the loop and surface the structured error.
        break;
      }

      // Exponential backoff with bounded symmetric jitter (shared helper).
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

// ─── Result-aware adapters (for non-throwing git executors) ──────────────────
//
// `withIndexLockRetry` above is throw-based: it engages when `op()` THROWS a
// lock error. But the two real call sites don't throw — they RETURN the failure
// (a `GitExecResult` with `exitCode !== 0`). The kernel's throw-plane wrapper is
// therefore inert over them (nothing is ever thrown to catch). These two thin
// adapters re-key the same bounded backoff onto a RESULT predicate
// ({@link isIndexLockResult}) instead of a thrown error, one async and one sync.
//
// Exhaustion contract: unlike the throw-plane wrapper (which throws
// `IndexLockContentionError`), the result-plane adapters RETURN the last failing
// result. That result is itself structured — `exitCode !== 0` with the lock
// signature still in `stderr`/`stdout` — so callers see a contention result, not
// a silent success/no-op, WITHOUT the adapter breaking the executor's
// "never throws" contract (which every `GitExec` consumer relies on).

/**
 * Async, result-aware variant of {@link withIndexLockRetry}. Runs a
 * (possibly async) git executor that REPORTS failures via its returned result
 * (never throws), retrying ONLY while the result is a transient `index.lock`
 * contention ({@link isIndexLockResult}) with the same DR-8 backoff sequence.
 * A success or a non-lock failure short-circuits immediately. On exhaustion the
 * last (still-structured) contention result is returned — never a silent no-op.
 *
 * Backoff/jitter/sleep are injected (via {@link IndexLockRetryOptions}); with
 * deterministic fakes the retry sequence is assertable.
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

  // Infinite loop with a return on every exit path: attempt 0 is the initial
  // run, 1..maxRetries are retries. `attempt >= maxRetries` on a contention
  // result exhausts the budget and returns that structured result.
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
 * Synchronous blocking sleep seam — invoked with a delay (ms). The synchronous
 * counterpart of {@link SleepFn}, needed because {@link withIndexLockRetrySync}
 * wraps a synchronous `GitExec` (`spawnSync`/`execFileSync`) and cannot `await`.
 */
export type SyncSleepFn = (ms: number) => void;

/**
 * Default real synchronous sleep. Blocks the calling thread for `ms` via
 * `Atomics.wait` on a throwaway `SharedArrayBuffer` — the standard way to sleep
 * synchronously in Node without a busy-spin. The bounded worst case is the
 * DR-8 backoff sum (~200+400+800 ≈ 1.5s), acceptable for keeping the pure merge
 * pipeline's synchronous contract intact. This is the ONLY place a real
 * synchronous wait happens; every testable path injects a fake {@link SyncSleepFn}.
 */
export const defaultSyncSleep: SyncSleepFn = (ms) => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Options for {@link withIndexLockRetrySync}. Mirrors {@link IndexLockRetryOptions}
 * but with a SYNCHRONOUS sleep + non-async `onRetry`, since the wrapped executor
 * is synchronous.
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
  /** Invoked once per retry, BEFORE the (blocking) backoff sleep. */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    lockPath: string;
  }) => void;
}

/**
 * Synchronous, result-aware variant of {@link withIndexLockRetry} used to wrap a
 * synchronous `GitExec`. `GitExec` runs `spawnSync`/`execFileSync` and REPORTS
 * failures via `exitCode` (never throws), so the retry engages on
 * {@link isIndexLockResult} rather than a thrown error, and sleeps SYNCHRONOUSLY
 * between attempts (bounded worst case ~1.5s) to preserve the pure merge
 * pipeline's synchronous contract.
 *
 * A naive async wrap of a synchronous, never-throwing executor is both
 * type-infeasible (the executor returns `R`, not `Promise<R>`) and inert
 * (nothing is ever thrown for the throw-plane wrapper to catch) — hence this
 * dedicated adapter.
 *
 * On exhaustion the last (still-structured) contention result is returned, never
 * a silent no-op, keeping the executor's "never throws" contract.
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

  // Infinite loop with a return on every exit path (see withIndexLockRetryResult).
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

// ─── Burst-creation stagger ─────────────────────────────────────────────────

/**
 * Compute a bounded stagger delay in `[minMs, maxMs]` from an injected signed
 * jitter source in `[-1, 1]`. Pure (no sleep) so the bound is unit-assertable.
 * `jitter() === 0` → band midpoint; `+1` → `maxMs`; `-1` → `minMs`; values
 * outside `[-1, 1]` are clamped to the band so a misbehaving source can never
 * produce an out-of-band stagger.
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
 * Stagger a burst-dispatched worktree creation/adoption by sleeping a bounded
 * jittered delay (DR-8 "creation/adoption staggered 100–500ms under burst").
 * Both the jitter source and the sleep seam are injected; returns the delay
 * actually applied so a caller (or test) can observe it.
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
