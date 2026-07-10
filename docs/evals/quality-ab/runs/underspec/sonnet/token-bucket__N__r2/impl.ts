export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  private tokens: number;
  private lastUpdateMs: number;

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
        `TokenBucket: capacity must be a positive finite number, got ${capacity}`,
      );
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `TokenBucket: refillPerSec must be a positive finite number, got ${refillPerSec}`,
      );
    }

    this.tokens = capacity;
    this.lastUpdateMs = clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Refill for elapsed time is always applied first (whether or not the
   * removal itself succeeds). Returns true and consumes the tokens if enough
   * are available; otherwise returns false and leaves the bucket unchanged.
   */
  tryRemove(count = 1): boolean {
    if (!Number.isInteger(count) || count <= 0) {
      throw new RangeError(
        `TokenBucket.tryRemove: count must be a positive integer, got ${count}`,
      );
    }

    this.refill();

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }

    return false;
  }

  /** Lazily top up tokens based on elapsed time since the last update. */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastUpdateMs;

    // Defensive: a non-monotonic clock (contract violation) should not
    // corrupt state — skip refill and keep the last known-good timestamp.
    if (elapsedMs <= 0) {
      return;
    }

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastUpdateMs = now;
  }
}
