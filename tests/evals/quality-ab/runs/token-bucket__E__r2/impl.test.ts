import { TokenBucket, type Clock } from './impl.ts';

// Hermetic fake clock — a real collaborator across the injected time seam.
// It honors the Clock contract (monotonic, non-decreasing ms) and is the only
// time source the bucket sees. We advance it explicitly; no wall-clock leakage.
class FakeClock implements Clock {
  private ms: number;
  constructor(startMs = 0) {
    this.ms = startMs;
  }
  now(): number {
    return this.ms;
  }
  advanceMs(delta: number): void {
    if (delta < 0) throw new Error('FakeClock must not go backward');
    this.ms += delta;
  }
  advanceSec(delta: number): void {
    this.advanceMs(delta * 1000);
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}`);
  }
}
function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// 1. Starts full: can drain exactly `capacity` at t0, next unit fails.
{
  const clk = new FakeClock(1000);
  const b = new TokenBucket(5, 1, clk);
  check('starts full: remove all capacity at once', b.tryRemove(5) === true);
  check('empty after draining: 1 more fails', b.tryRemove(1) === false);
}

// 2. Default count is 1.
{
  const clk = new FakeClock();
  const b = new TokenBucket(2, 1, clk);
  check('default remove 1 #1', b.tryRemove() === true);
  check('default remove 1 #2', b.tryRemove() === true);
  check('default remove 1 #3 (empty)', b.tryRemove() === false);
}

// 3. No partial consumption on failure: a failed larger request leaves balance intact.
{
  const clk = new FakeClock();
  const b = new TokenBucket(10, 1, clk);
  check('drain to 3 left', b.tryRemove(7) === true);
  check('request 5 (only 3) fails', b.tryRemove(5) === false);
  // Balance untouched -> the 3 that remain are still fully spendable.
  check('remaining 3 still fully available', b.tryRemove(3) === true);
  check('now truly empty', b.tryRemove(1) === false);
}

// 4. Request > capacity can never succeed, even on a full bucket, and consumes nothing.
{
  const clk = new FakeClock();
  const b = new TokenBucket(4, 1, clk);
  check('over-capacity request fails on full bucket', b.tryRemove(5) === false);
  check('full bucket untouched after over-cap request', b.tryRemove(4) === true);
}

// 5. Continuous/proportional refill across the real clock seam.
{
  const clk = new FakeClock();
  const b = new TokenBucket(10, 2, clk); // 2 tokens/sec
  check('drain full', b.tryRemove(10) === true);
  check('empty right after drain', b.tryRemove(1) === false);
  clk.advanceMs(500); // 0.5s * 2/s = 1 token
  check('after 500ms exactly 1 token: remove 1 ok', b.tryRemove(1) === true);
  check('after spending it, empty again', b.tryRemove(1) === false);
  clk.advanceMs(1500); // 1.5s * 2/s = 3 tokens
  check('after 1500ms: 3 available, 4 not', b.tryRemove(4) === false);
  check('after 1500ms: 3 available', b.tryRemove(3) === true);
}

// 6. Fractional balances accumulate and are not lost between calls.
{
  const clk = new FakeClock();
  const b = new TokenBucket(10, 1, clk); // 1 token/sec
  check('drain full', b.tryRemove(10) === true);
  clk.advanceMs(400); // +0.4
  check('0.4 tokens: cannot remove 1', b.tryRemove(1) === false);
  clk.advanceMs(400); // +0.4 -> 0.8
  check('0.8 tokens: still cannot remove 1', b.tryRemove(1) === false);
  clk.advanceMs(400); // +0.4 -> 1.2
  check('1.2 tokens: can remove 1', b.tryRemove(1) === true);
  // ~0.2 left now, cannot remove another whole token
  check('~0.2 left: cannot remove 1', b.tryRemove(1) === false);
}

// 7. Refill never exceeds capacity (long idle does not overfill).
{
  const clk = new FakeClock();
  const b = new TokenBucket(3, 5, clk); // huge refill rate
  check('drain full', b.tryRemove(3) === true);
  clk.advanceSec(1000); // would add 5000 tokens uncapped
  check('capped at capacity: remove 3 ok', b.tryRemove(3) === true);
  check('capped at capacity: not 4th (would exceed cap)', b.tryRemove(1) === false);
}

// 8. Balance never goes negative and refill anchors from consumption, not idle time.
{
  const clk = new FakeClock();
  const b = new TokenBucket(2, 1, clk);
  check('remove 2 ok', b.tryRemove(2) === true);
  clk.advanceMs(999); // +0.999, still < 1
  check('0.999: cannot remove 1 (no negative, no round-up)', b.tryRemove(1) === false);
  clk.advanceMs(1); // -> 1.0 exactly
  check('exactly 1.0: remove 1 ok', b.tryRemove(1) === true);
}

// 9. Monotonic-but-stalled clock (delta 0) is a no-op refill.
{
  const clk = new FakeClock(50);
  const b = new TokenBucket(5, 10, clk);
  b.tryRemove(5);
  // No time advance between calls.
  check('no time passed: still empty', b.tryRemove(1) === false);
  check('no time passed: still empty (repeat)', b.tryRemove(1) === false);
}

// 10. Cross-seam integration: interleave consumption and refill many times,
// tracking an independent oracle balance to confirm the contract end-to-end.
{
  const clk = new FakeClock();
  const capacity = 100;
  const rate = 3; // tokens/sec
  const b = new TokenBucket(capacity, rate, clk);
  let oracle = capacity;
  const stepsMs = [250, 1000, 40, 5000, 333, 700, 9999, 12];
  const asks = [10, 3, 100, 7, 250, 1, 55, 2];
  for (let i = 0; i < stepsMs.length; i++) {
    clk.advanceMs(stepsMs[i]!);
    oracle = Math.min(capacity, oracle + (rate * stepsMs[i]!) / 1000);
    const ask = asks[i]!;
    const expected = ask <= capacity && oracle + 1e-9 >= ask;
    const got = b.tryRemove(ask);
    check(`oracle step ${i} (ask ${ask})`, got === expected);
    if (got) oracle -= ask;
    check(`oracle non-negative step ${i}`, oracle >= -1e-9);
  }
}

// Meta kill-probe: prove approx helper + at least one contract assertion truly discriminates.
check('approx sanity true', approx(1.0, 1.0));
check('approx sanity false-detect', !approx(1.0, 1.2, 1e-9));

if (failed === 0) {
  console.log(`OK — ${passed} assertions passed`);
} else {
  console.error(`${failed} assertion(s) FAILED (${passed} passed)`);
  process.exit(1);
}
