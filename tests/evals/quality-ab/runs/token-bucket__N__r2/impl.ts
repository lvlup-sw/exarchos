export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  /** Current token balance; may be fractional. Starts full. */
  private tokens: number;
  /** Clock time (ms) at which `tokens` was last recomputed. */
  private lastRefill: number;

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
    this.tokens = capacity;
    this.lastRefill = clock.now();
  }

  /** Lazily add tokens for the elapsed time, capped at `capacity`. */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefill;
    // Clock is monotonic/non-decreasing; guard against any non-positive delta
    // so a zero-time or stalled clock never removes tokens.
    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
    }
    this.lastRefill = now;
  }

  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error('count must be a positive integer');
    }
    // A request larger than capacity can never be satisfied.
    if (count > this.capacity) {
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
