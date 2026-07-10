export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous (proportional) token-bucket rate limiter.
 *
 * The bucket starts full and refills lazily: on each {@link TokenBucket.tryRemove}
 * call we first credit `refillPerSec * Δms / 1000` tokens for the time elapsed
 * on the injected {@link Clock} since the last update, clamped to `capacity`.
 *
 * All time comes from the injected clock — the wall clock is never read here,
 * which keeps the type deterministic and testable.
 */
export class TokenBucket {
  /** Current token level; may be fractional between refills. */
  private tokens: number;
  /** Clock timestamp (ms) at which `tokens` was last brought up to date. */
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
      throw new RangeError(
        `capacity must be a positive finite number, got ${capacity}`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a positive finite number, got ${refillPerSec}`,
      );
    }

    // Bucket starts full.
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   *
   * Applies the pending continuous refill first, then consumes `count` tokens
   * iff at least that many are available.
   *
   * @returns `true` (and consumes) when enough tokens are available; else `false`.
   * @throws RangeError if `count` is not a positive integer.
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
   * Credit tokens for the time elapsed since the last update.
   *
   * The refill is linear in elapsed time and advances `lastRefillMs` to the
   * current clock reading, so the outcome is identical whether time is consumed
   * in one large jump or many small increments. A non-positive delta (a clock
   * that has not advanced, or — defensively — has gone backwards despite the
   * monotonic contract) credits nothing and preserves the later reference
   * timestamp so no phantom tokens can accrue.
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }

    const refilled = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = now;
  }
}
