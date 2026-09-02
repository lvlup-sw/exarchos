export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  private tokens: number;
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
    if (!(capacity > 0)) {
      throw new Error('capacity must be > 0');
    }
    if (!(refillPerSec > 0)) {
      throw new Error('refillPerSec must be > 0');
    }
    // Bucket starts full.
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /** Apply lazy, proportional refill for time elapsed since the last update. */
  private refill(): void {
    const nowMs = this.clock.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    // Clock is monotonic/non-decreasing, but guard against zero/negative drift.
    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
    }
    // Advance the marker so refill is not double-counted on the next call.
    this.lastRefillMs = nowMs;
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false and consumes NOTHING.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('count must be a positive integer');
    }
    // A request larger than capacity can never succeed.
    if (count > this.capacity) {
      // Still fold in elapsed refill so state stays consistent.
      this.refill();
      return false;
    }

    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}
