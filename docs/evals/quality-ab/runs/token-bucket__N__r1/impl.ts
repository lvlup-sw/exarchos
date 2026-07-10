export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly clock: Clock;

  /** Current (possibly fractional) token balance. */
  private tokens: number;
  /** Clock time (ms) at which `tokens` was last computed. */
  private lastRefillMs: number;

  /**
   * @param capacity      max tokens the bucket holds (> 0)
   * @param refillPerSec  tokens added per second (> 0), continuous/proportional
   * @param clock         injected time source (do NOT read wall-clock directly)
   */
  constructor(capacity: number, refillPerSec: number, clock: Clock) {
    if (typeof capacity !== 'number' || !isFinite(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive finite number, got ${capacity}`);
    }
    if (typeof refillPerSec !== 'number' || !isFinite(refillPerSec) || refillPerSec <= 0) {
      throw new RangeError(
        `refillPerSec must be a positive finite number, got ${refillPerSec}`,
      );
    }

    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.clock = clock;

    // Bucket starts full.
    this.tokens = capacity;
    this.lastRefillMs = clock.now();
  }

  /**
   * Bring the token balance up to date for the elapsed clock time, capping at
   * capacity. Lazy refill: only ever called from `tryRemove`.
   */
  private refill(): void {
    const nowMs = this.clock.now();
    const elapsedMs = nowMs - this.lastRefillMs;

    // Clock is documented monotonic/non-decreasing; guard defensively so a
    // stalled or non-advancing reading never subtracts tokens.
    if (elapsedMs > 0) {
      const added = (this.refillPerSec * elapsedMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + added);
    }

    // Always advance the reference point to the observed time so future
    // refills measure from "now", not from the last positive step.
    if (nowMs > this.lastRefillMs) {
      this.lastRefillMs = nowMs;
    }
  }

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false and consumes NOTHING.
   */
  tryRemove(count = 1): boolean {
    if (
      typeof count !== 'number' ||
      !isFinite(count) ||
      Math.floor(count) !== count ||
      count <= 0
    ) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }

    // A request for more than capacity can never succeed, and never consumes.
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
