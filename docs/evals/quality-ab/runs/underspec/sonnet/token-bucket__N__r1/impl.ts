export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

/**
 * Tolerance for floating-point drift that can accumulate across many small
 * lazy refill computations (e.g. repeated sub-millisecond deltas). Without
 * this, a mathematically-exact `tokens === count` comparison can spuriously
 * fail due to IEEE-754 rounding (e.g. `4.999999999999999 >= 5` being false).
 */
const EPSILON = 1e-9;

export class TokenBucket {
  private tokens: number;
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
        `capacity must be a finite number > 0, got ${capacity}`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a finite number > 0, got ${refillPerSec}`,
      );
    }

    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /**
   * Lazily applies refill for elapsed time since the last update. Tokens
   * never exceed `capacity`. If the clock hasn't advanced (or, defensively,
   * appears to have gone backwards relative to our documented monotonic
   * contract), no tokens are added but the reference point is still moved
   * forward to avoid re-computing the same interval twice.
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefill;
    this.lastRefill = now;

    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
    }
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(
        `count must be a positive integer, got ${count}`,
      );
    }

    this.refill();

    if (this.tokens + EPSILON >= count) {
      // Clamp to zero to absorb the tiny epsilon slack we just allowed above,
      // rather than letting the token count drift slightly negative.
      this.tokens = Math.max(0, this.tokens - count);
      return true;
    }

    return false;
  }
}
