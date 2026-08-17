import { TokenBucket, type Clock } from './impl.ts';

/**
 * Hermetic fake clock — a real collaborator across the injected seam.
 * It honors the Clock contract (monotonic, non-decreasing, ms) and is the
 * only time source the bucket ever sees.
 */
class FakeClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  /** Advance time by `ms` milliseconds (must be >= 0 to stay monotonic). */
  advance(ms: number): void {
    if (ms < 0) throw new Error('clock cannot go backwards');
    this.t += ms;
  }
}

let failures = 0;
let count = 0;

function check(name: string, cond: boolean): void {
  count++;
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${name}`);
  } else {
    console.log(`  ok:   ${name}`);
  }
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// 1. Bucket starts full: capacity=5 → can immediately remove 5, not 6.
{
  const clk = new FakeClock(1000);
  const b = new TokenBucket(5, 10, clk);
  check('starts full: can remove exactly capacity', b.tryRemove(5) === true);
}
{
  const clk = new FakeClock(1000);
  const b = new TokenBucket(5, 10, clk);
  check('starts full: cannot remove capacity+1', b.tryRemove(6) === false);
}

// 2. Default count = 1.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(2, 1, clk);
  check('default removes 1 (first)', b.tryRemove() === true);
  check('default removes 1 (second)', b.tryRemove() === true);
  check('default fails when empty (no time passed)', b.tryRemove() === false);
}

// 3. Insufficient → false and consumes NOTHING.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(3, 1, clk);
  check('consume 2 of 3', b.tryRemove(2) === true);
  // 1 token left, ask for 2 → false, must leave the 1 untouched.
  check('reject 2 with only 1 left', b.tryRemove(2) === false);
  check('the untouched token is still consumable', b.tryRemove(1) === true);
  check('now truly empty', b.tryRemove(1) === false);
}

// 4. Continuous proportional refill across the clock seam.
//    refillPerSec=2 → 0.5s later, 1 token returns.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 2, clk);
  // Drain to empty.
  check('drain 10', b.tryRemove(10) === true);
  check('empty rejects 1', b.tryRemove(1) === false);
  clk.advance(500); // 0.5s * 2/s = 1 token
  check('after 500ms one token available', b.tryRemove(1) === true);
  check('but not a second token', b.tryRemove(1) === false);
}

// 5. Fractional/partial refill accumulates precisely.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 4, clk); // 4 tokens/sec
  check('drain 10 (frac test)', b.tryRemove(10) === true);
  clk.advance(250); // 0.25s * 4 = 1.0 token
  clk.advance(250); // another 1.0 → 2.0 total, proving refill isn't reset spuriously
  check('two 250ms steps yield 2 tokens', b.tryRemove(2) === true);
  check('no third token', b.tryRemove(1) === false);
}

// 6. Refill never exceeds capacity (over-long idle does not overfill).
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(3, 1000, clk);
  check('drain 3', b.tryRemove(3) === true);
  clk.advance(10_000); // would add 10000 tokens uncapped
  check('cap holds: can take exactly capacity', b.tryRemove(3) === true);
  check('cap holds: cannot take capacity+1', b.tryRemove(1) === false);
}

// 7. Request > capacity can NEVER succeed, even after long refill.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(4, 100, clk);
  clk.advance(1_000_000);
  check('over-capacity request always false', b.tryRemove(5) === false);
  // And it consumed nothing: full capacity still removable.
  check('over-capacity request consumed nothing', b.tryRemove(4) === true);
}

// 8. Token count never goes negative + refill math sanity via a fractional
//    balance that is not yet enough.
{
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 2, clk); // 2/sec
  check('drain 10 (neg test)', b.tryRemove(10) === true);
  clk.advance(400); // 0.8 tokens — less than 1
  check('0.8 tokens not enough for 1', b.tryRemove(1) === false);
  clk.advance(100); // +0.2 → 1.0 exactly
  check('reaching exactly 1.0 succeeds', b.tryRemove(1) === true);
  check('back to empty, reject', b.tryRemove(1) === false);
}

// 9. Zero elapsed time between calls must not fabricate tokens.
{
  const clk = new FakeClock(42);
  const b = new TokenBucket(2, 1000, clk);
  check('drain 2', b.tryRemove(2) === true);
  // No advance → same instant.
  check('same instant: no free token', b.tryRemove(1) === false);
}

// 10. Direct arithmetic contract: after draining and advancing, the exact
//     fractional balance is what the spec formula predicts.
{
  const clk = new FakeClock(0);
  const refillPerSec = 3;
  const b = new TokenBucket(20, refillPerSec, clk);
  check('drain 20', b.tryRemove(20) === true);
  const dtMs = 700;
  clk.advance(dtMs);
  const expected = (refillPerSec * dtMs) / 1000; // 2.1
  check('formula: 2.1 tokens → can take floor 2', b.tryRemove(2) === true);
  // 0.1 remains; taking 1 must fail.
  check('formula: 0.1 remains, reject 1', b.tryRemove(1) === false);
  check('formula sanity (approx)', approx(expected, 2.1));
}

console.log(`\n${count - failures}/${count} checks passed`);
if (failures > 0) {
  throw new Error(`${failures} FAILURES`);
}
