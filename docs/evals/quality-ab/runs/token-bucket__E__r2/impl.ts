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
    // The bucket starts full.
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /** Lazily add tokens proportional to elapsed clock time, capped at capacity. */
  private refill(): void {
    const nowMs = this.clock.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    // Clock is monotonic/non-decreasing; guard against zero/backward drift so
    // we never subtract tokens or move lastRefill backwards.
    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
      this.lastRefillMs = nowMs;
    }
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
    // A request for more than capacity can never succeed.
    if (count > this.capacity) {
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
