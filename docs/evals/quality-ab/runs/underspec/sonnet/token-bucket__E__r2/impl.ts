export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  /** Current token count (fractional; refilled lazily). */
  private tokens: number;
  /** Clock time (ms) at which `tokens` was last brought up to date. */
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
    this.lastRefillMs = this.clock.now();
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false. Refill for elapsed time is applied first, on every call, whether
   * or not the removal ultimately succeeds.
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
   * Lazily credit tokens for elapsed clock time since the last update,
   * capped at capacity. Always advances `lastRefillMs` when time has moved
   * forward, so the same interval is never credited twice (including on a
   * failed `tryRemove`, since the refill already happened before the check).
   */
  private refill(): void {
    const now = this.clock.now();
    const elapsedMs = now - this.lastRefillMs;

    if (elapsedMs <= 0) {
      // Nothing elapsed (or the clock defied its non-decreasing contract).
      // Defensively skip crediting rather than adding negative tokens, and
      // leave lastRefillMs alone so no time window is silently dropped.
      return;
    }

    const added = (this.refillPerSec * elapsedMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}
