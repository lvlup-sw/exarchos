export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  /** Current token count (may hold fractional tokens between calls). */
  private tokens: number;

  /** Clock reading at which `tokens` was last brought up to date. */
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
      throw new RangeError(
        `TokenBucket: capacity must be > 0, got ${capacity}`,
      );
    }
    if (!(refillPerSec > 0)) {
      throw new RangeError(
        `TokenBucket: refillPerSec must be > 0, got ${refillPerSec}`,
      );
    }

    // The bucket starts full.
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

  /**
   * Lazily bring `tokens` up to date by adding whatever has accrued
   * proportionally to elapsed clock time since the last update, capped at
   * `capacity`.
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefillMs;

    // Guard against a clock that hasn't advanced (or, defensively, one that
    // ever reports a value that doesn't move forward): only add tokens and
    // move the watermark when real forward progress happened, so a
    // same-timestamp or backward reading can never grant phantom tokens or
    // corrupt the elapsed-time baseline.
    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
      this.lastRefillMs = now;
    }
  }
}
