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
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive finite number, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(`refillPerSec must be a positive finite number, got ${refillPerSec}`);
    }

    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    this.refill();

    if (this.tokens < count) {
      return false;
    }

    this.tokens -= count;
    return true;
  }

  /**
   * Lazily applies refill proportional to elapsed clock time since the last
   * update, capping at `capacity`. Guards against a non-monotonic clock by
   * skipping (rather than corrupting state on) a zero/negative delta.
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefillMs;

    if (elapsedMs <= 0) {
      return;
    }

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}
