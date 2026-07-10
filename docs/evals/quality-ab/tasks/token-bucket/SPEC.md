# Task: TokenBucket rate limiter

**Risk Tier:** high · **Boundary Touching:** true
**Test Layer:** integration

Implement a token-bucket rate limiter in `impl.ts`, exporting exactly:

```ts
export interface Clock {
  /** Current time in milliseconds (monotonic, non-decreasing). */
  now(): number;
}

export class TokenBucket {
  /**
   * @param capacity      max tokens the bucket holds (> 0)
   * @param refillPerSec  tokens added per second (> 0), continuous/proportional
   * @param clock         injected time source (do NOT read wall-clock directly)
   */
  constructor(capacity: number, refillPerSec: number, clock: Clock);

  /**
   * Attempt to remove `count` tokens (default 1, a positive integer).
   * Returns true and consumes them if enough are available; otherwise returns
   * false and consumes NOTHING.
   */
  tryRemove(count?: number): boolean;
}
```

## Semantics

- The bucket starts **full** (`capacity` tokens).
- Tokens refill **continuously and proportionally** to elapsed clock time since
  the last update: after `Δms`, `refillPerSec * Δms / 1000` tokens are added.
  Refill is lazy (compute it when `tryRemove` is called), never exceeding
  `capacity`.
- `tryRemove(n)`: first apply refill for the elapsed time, then if the bucket
  holds at least `n` tokens, subtract `n` and return `true`; otherwise return
  `false` and leave the token count unchanged (no partial consumption).
- A request for more than `capacity` tokens can never succeed.
- Token count must never go negative.
- Fractional token balances are allowed internally (time-based refill); only the
  cap and the "enough for this request" check matter externally.

Implement it well. This is a high-risk, boundary-touching task (it defines a
reusable contract with an injected time seam) — verify the behavior thoroughly.
