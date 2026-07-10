export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous (proportional) token-bucket rate limiter.
 *
 * The bucket starts full and refills lazily: on every {@link TokenBucket.tryRemove}
 * call we first credit `refillPerSec * elapsedMs / 1000` tokens for the time that
 * has passed on the injected {@link Clock} (capped at `capacity`), then attempt the
 * removal. Time is read *only* through the injected clock — never the wall clock —
 * so the class is fully deterministic and testable across that seam.
 */
export class TokenBucket {
  /**
   * Floating-point slack for the "enough tokens?" comparison.
   *
   * Continuous refill accumulates rounding error (e.g. summing 0.1 tokens ten
   * times yields 0.9999999999999999, not 1.0). Without slack a caller that has
   * genuinely waited long enough would be spuriously rejected at integer
   * boundaries. The tolerance is ~1e9× smaller than any meaningful token delta,
   * and every granted epsilon is subtracted back out (the bucket may dip a hair
   * below zero), so it never permits net over-consumption.
   */
  private static readonly EPSILON = 1e-9;

  /** Current token level; may transiently dip a sub-epsilon amount below 0. */
  private tokens: number;

  /** Clock timestamp (ms) at which {@link tokens} was last recomputed. */
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
    if (clock == null || typeof clock.now !== 'function') {
      throw new TypeError('clock must provide a now(): number method');
    }

    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   *
   * Refill for the elapsed clock time is applied first; then, if the bucket holds
   * at least `count` tokens, they are consumed and `true` is returned. Otherwise
   * nothing is consumed and `false` is returned (this includes `count > capacity`,
   * which can never be satisfied).
   *
   * @throws RangeError if `count` is not a positive integer.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    this.refill(this.clock.now());

    if (this.tokens + TokenBucket.EPSILON >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Credit tokens for the time elapsed since the last update and advance the
   * refill marker. Non-positive elapsed time (equal timestamps, or a
   * misbehaving non-monotonic clock) is a no-op so the marker never moves
   * backwards and no phantom tokens are minted.
   */
  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) {
      return;
    }

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = nowMs;
  }
}
