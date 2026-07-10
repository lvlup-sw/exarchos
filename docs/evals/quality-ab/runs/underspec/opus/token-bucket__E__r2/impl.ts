export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous (proportional) token-bucket rate limiter.
 *
 * The bucket starts full. Tokens refill lazily and continuously: whenever
 * `tryRemove` runs it first credits `refillPerSec * Δms / 1000` tokens for the
 * time elapsed on the injected {@link Clock} since the last update (capped at
 * `capacity`), then attempts the removal.
 *
 * Time is read exclusively through the injected `Clock` seam — never the
 * wall-clock — so behavior is fully deterministic under test.
 */
export class TokenBucket {
  /** Current (possibly fractional) token count; always in [0, capacity]. */
  private tokens: number;
  /** Clock timestamp (ms) at which `tokens` was last brought up to date. */
  private lastRefill: number;

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
      throw new RangeError(
        `capacity must be a finite number > 0 (got ${String(capacity)})`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a finite number > 0 (got ${String(refillPerSec)})`,
      );
    }

    // Bucket starts full.
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /**
   * Bring `tokens` up to date for the time elapsed since `lastRefill`.
   *
   * Refill is continuous and proportional. The clock is contractually
   * monotonic; we defensively clamp any non-positive delta to 0 so a
   * misbehaving clock can never *drain* the bucket, and we only advance
   * `lastRefill` forward.
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefill;

    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
      this.lastRefill = now;
    }
  }

  /**
   * Attempt to remove `count` tokens (default 1, must be a positive integer).
   *
   * Applies pending refill first, then consumes and returns `true` if at least
   * `count` tokens are available; otherwise leaves the bucket untouched and
   * returns `false`.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(
        `count must be a positive integer (got ${String(count)})`,
      );
    }

    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}
