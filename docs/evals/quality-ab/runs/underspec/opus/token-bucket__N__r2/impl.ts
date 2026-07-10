export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous, proportional token-bucket rate limiter.
 *
 * The bucket starts full and refills lazily: on each {@link tryRemove} call the
 * elapsed time since the last update is converted to tokens
 * (`refillPerSec * Δms / 1000`) and added, saturating at `capacity`.
 *
 * All timing flows through the injected {@link Clock} — wall-clock time is
 * never read directly — so behavior is fully deterministic under test.
 */
export class TokenBucket {
  /** Current token level; a real number in the range [0, capacity]. */
  private tokens: number;

  /** Clock reading (ms) at which `tokens` was last recomputed. */
  private lastRefillMs: number;

  /**
   * @param capacity      max tokens the bucket holds (> 0)
   * @param refillPerSec  tokens added per second (> 0), continuous/proportional
   * @param clock         injected time source (do NOT read wall-clock directly)
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a finite number > 0, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(`refillPerSec must be a finite number > 0, got ${refillPerSec}`);
    }

    // Start full, anchored to the clock's current reading.
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   *
   * Applies the pending lazy refill for the elapsed clock time first, then
   * consumes the tokens iff at least `count` are available.
   *
   * @returns `true` (and consumes `count` tokens) if enough were available,
   *          otherwise `false` (and the bucket is left unchanged).
   * @throws  RangeError if `count` is not a positive integer.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    this.refill(this.clock.now());

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Add tokens for the time elapsed since the last update, saturating at
   * `capacity`. Guards against a non-advancing (or, defensively, backward)
   * clock reading: no tokens are added and `lastRefillMs` is never rewound, so
   * a later forward reading is always measured from the furthest point already
   * observed.
   */
  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }

    const refilled = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = nowMs;
  }
}
