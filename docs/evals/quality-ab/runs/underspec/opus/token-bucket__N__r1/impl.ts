export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  /** Current token count; may be fractional due to continuous refill. */
  private tokens: number;

  /** Clock timestamp (ms) at which `tokens` was last brought up to date. */
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
      throw new RangeError(`capacity must be a finite number > 0, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(`refillPerSec must be a finite number > 0, got ${refillPerSec}`);
    }

    // Bucket starts full.
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

    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Lazily add tokens for the time elapsed since the last update, capped at
   * `capacity`. Overflow tokens are discarded (standard token-bucket behavior).
   */
  private refill(): void {
    const now = this.clock.now();

    // Clock is documented monotonic non-decreasing; clamp defensively so a
    // spurious backwards reading never grants (or removes) tokens, and never
    // rewinds our high-water mark.
    const elapsedMs = now - this.lastRefillMs;
    if (elapsedMs <= 0) {
      if (now > this.lastRefillMs) {
        this.lastRefillMs = now;
      }
      return;
    }

    const refilled = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefillMs = now;
  }
}
