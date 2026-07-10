export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Continuous refill is computed with IEEE-754 doubles, so a refill that should
 * land the bucket *exactly* on a boundary (e.g. 0.999 + 0.001) can be off by a
 * few ULPs. This tolerance makes the "enough tokens?" comparison robust to that
 * representation error without ever accepting a removal that is short by a
 * meaningful (sub-nanotoken) amount.
 */
const COMPARISON_EPSILON = 1e-9;

/**
 * A classic token-bucket rate limiter.
 *
 * The bucket starts full and refills continuously and proportionally to elapsed
 * time reported by the injected {@link Clock}. Refill is lazy: it is applied at
 * the start of each {@link TokenBucket.tryRemove} call, so no timers are used
 * and the class is fully deterministic under a mock clock.
 */
export class TokenBucket {
  /** Current token count. Fractional between whole refills. */
  private tokens: number;

  /** Clock timestamp (ms) at which {@link tokens} was last recomputed. */
  private lastRefillMs: number;

  /**
   * @param capacity      max tokens the bucket holds (must be finite and > 0)
   * @param refillPerSec  tokens added per second (must be finite and > 0)
   * @param clock         injected time source (do NOT read wall-clock directly)
   */
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(
        `capacity must be a finite number > 0, got ${String(capacity)}`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a finite number > 0, got ${String(refillPerSec)}`,
      );
    }
    if (clock == null || typeof clock.now !== 'function') {
      throw new TypeError('clock must provide a now(): number method');
    }

    // Start full, anchored to the clock's current reading (which may be > 0).
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, must be a positive integer).
   *
   * Applies the pending refill first, then removes the tokens if at least
   * `count` are available.
   *
   * @returns `true` and consumes the tokens if enough are available; otherwise
   *          `false` and leaves the bucket unchanged.
   * @throws RangeError if `count` is not a positive integer.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(
        `count must be a positive integer, got ${String(count)}`,
      );
    }

    this.refill(this.clock.now());

    if (this.tokens + COMPARISON_EPSILON >= count) {
      // Clamp to guard against tiny negative residue from the epsilon accept.
      this.tokens = Math.max(0, this.tokens - count);
      return true;
    }
    return false;
  }

  /**
   * Add tokens for the time elapsed since {@link lastRefillMs}, capped at
   * {@link capacity}, and advance the anchor.
   *
   * The {@link Clock} contract guarantees monotonic, non-decreasing time; we
   * still defend against a backward jump by never *removing* tokens and never
   * moving the anchor backward, so a misbehaving clock cannot penalize callers.
   */
  private refill(nowMs: number): void {
    const elapsedMs = nowMs - this.lastRefillMs;

    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
      this.lastRefillMs = nowMs;
    }
    // elapsedMs <= 0: no forward progress; leave tokens and anchor untouched.
  }
}
