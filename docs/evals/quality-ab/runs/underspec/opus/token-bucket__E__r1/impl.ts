export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous (proportional) token-bucket rate limiter.
 *
 * The bucket starts full and refills lazily: elapsed time is only converted to
 * tokens when {@link TokenBucket.tryRemove} is called. All time comes from the
 * injected {@link Clock} — this class never reads the wall clock directly, so
 * behavior is fully deterministic under test.
 */
export class TokenBucket {
  /** Current token level; always within `[0, capacity]`. */
  private tokens: number;

  /**
   * The clock timestamp (ms) that {@link tokens} is accurate as of. Only ever
   * moves forward; a non-increasing clock reading yields no refill.
   */
  private lastNow: number;

  /**
   * @param capacity      max tokens the bucket holds (> 0, finite)
   * @param refillPerSec  tokens added per second (> 0, finite), continuous/proportional
   * @param clock         injected time source (do NOT read wall-clock directly)
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(
        `capacity must be a positive finite number, got ${capacity}`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a positive finite number, got ${refillPerSec}`,
      );
    }

    // Starts full, timestamped against the injected clock so no "startup
    // windfall" of tokens accrues before the first call.
    this.tokens = capacity;
    this.lastNow = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, must be a positive integer).
   *
   * Refill for the elapsed time is applied first; then if the bucket holds at
   * least `count` tokens they are consumed and `true` is returned. Otherwise
   * the bucket is left untouched (aside from the refill) and `false` returned.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Lazily credit tokens for the time elapsed since {@link lastNow}, capped at
   * {@link capacity}. Advancing {@link lastNow} here is what prevents the same
   * interval from being counted twice on subsequent calls.
   */
  private refill(): void {
    const now = this.clock.now();

    // Clock is contractually monotonic non-decreasing; guard defensively so a
    // stale/equal reading never subtracts tokens or rewinds our baseline.
    if (now <= this.lastNow) {
      return;
    }

    const elapsedMs = now - this.lastNow;
    this.lastNow = now;

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
  }
}
