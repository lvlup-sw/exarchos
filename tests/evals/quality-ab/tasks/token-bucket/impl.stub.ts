export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    // TODO: implement
  }

  tryRemove(count = 1): boolean {
    // TODO: implement
    throw new Error('not implemented');
  }
}
