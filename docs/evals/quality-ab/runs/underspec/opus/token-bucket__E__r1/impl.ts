export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous (proportional) token-bucket rate limiter.
 *
 * The bucket starts full and refills lazily: the elapsed time since the last
 * update is converted to fractional tokens only when {@link TokenBucket.tryRemove}
 * is called. Time is read exclusively through the injected {@link Clock} seam so
 * the limiter is fully deterministic under test.
 */
export class TokenBucket {
  /** Current (possibly fractional) token count, always in [0, capacity]. */
  private tokens: number;

  /**
   * High-water mark of the clock reading used for the last refill. Never moves
   * backwards, so a misbehaving (non-monotonic) clock cannot mint tokens.
   */
  private lastRefillMs: number;

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
      throw new RangeError(`capacity must be a finite number > 0, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(`refillPerSec must be a finite number > 0, got ${refillPerSec}`);
    }

    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Applies the lazy refill first, then consumes if enough tokens are present.
   *
   * @returns `true` (and consumes `count`) if enough tokens are available;
   *          otherwise `false` (and consumes nothing).
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    const now = this.clock.now();
    this.refill(now);

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Add tokens proportional to the elapsed time since the last refill. */
  private refill(now: number): void {
    // Guard against a non-monotonic clock: only advance on forward progress,
    // and never lower the high-water mark (which would inflate a later delta).
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}
