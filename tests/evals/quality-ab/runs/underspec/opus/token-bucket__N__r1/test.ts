import { TokenBucket, type Clock } from './impl.ts';

/** Deterministic, mutable clock for driving the lazy refill. */
class MockClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. Bucket starts full.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 5, clock);
  check('starts full: can remove full capacity at t=0', b.tryRemove(10) === true);
  check('starts full: empty after draining', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 2. Default count is 1.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(3, 1, clock);
  check('default count removes 1 (a)', b.tryRemove() === true);
  check('default count removes 1 (b)', b.tryRemove() === true);
  check('default count removes 1 (c)', b.tryRemove() === true);
  check('default count: empty after 3 removes', b.tryRemove() === false);
}

// ---------------------------------------------------------------------------
// 3. Proportional refill.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 5, clock); // 5 tokens/sec => 1 token / 200ms
  check('refill: drain to empty', b.tryRemove(10) === true);
  check('refill: empty immediately after drain', b.tryRemove(1) === false);
  clock.advance(200); // +1 token
  check('refill: 1 token back after 200ms', b.tryRemove(1) === true);
  check('refill: empty again after consuming the refill', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 4. Fractional boundary (just-under vs exactly-on).
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 1, clock); // 1 token/sec
  check('boundary: drain to empty', b.tryRemove(10) === true);
  clock.advance(999); // 0.999 tokens
  check('boundary: 999ms is not enough for 1 token', b.tryRemove(1) === false);
  clock.advance(1); // now exactly 1.0 token (subject to float rounding)
  check('boundary: 1000ms yields exactly 1 token', b.tryRemove(1) === true);
  check('boundary: empty after consuming it', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 5. Refill is capped at capacity (no overfill on long idle).
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 100, clock);
  check('cap: drain to empty', b.tryRemove(10) === true);
  clock.advance(10_000); // would add 1000 tokens if uncapped
  check('cap: can take full capacity', b.tryRemove(10) === true);
  check('cap: cannot exceed capacity', b.tryRemove(1) === false);
}

// Idle from the very start must also stay capped (starts full, never overfills).
{
  const clock = new MockClock(0);
  const b = new TokenBucket(4, 10, clock);
  clock.advance(60_000);
  check('cap: idle-from-start stays at capacity', b.tryRemove(4) === true);
  check('cap: idle-from-start not overfilled', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 6. Continuous accumulation across many calls == one big elapsed.
//    (0.5-token additions are exact in binary floating point.)
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 10, clock); // 10/sec => 0.5 token / 50ms
  check('accumulate: drain to empty', b.tryRemove(10) === true);
  for (let i = 0; i < 20; i++) {
    clock.advance(50); // +0.5 token, but a failing tryRemove forces the refill
    // Requesting more than possible keeps the bucket unchanged while refilling.
    b.tryRemove(11);
  }
  // 20 * 0.5 == 10 tokens accumulated across 20 separate refills.
  check('accumulate: 20x50ms == full bucket', b.tryRemove(10) === true);
  check('accumulate: empty after taking the accumulated tokens', b.tryRemove(1) === false);
}

// Single-shot equivalent of the accumulation above.
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 10, clock);
  check('single-shot: drain to empty', b.tryRemove(10) === true);
  clock.advance(1000); // one 1000ms step == 10 tokens
  check('single-shot: 1000ms == full bucket', b.tryRemove(10) === true);
  check('single-shot: empty afterwards', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 7. count > capacity can never succeed and never mutates the bucket.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(5, 5, clock);
  check('oversize: request > capacity fails', b.tryRemove(6) === false);
  check('oversize: bucket untouched, still full', b.tryRemove(5) === true);
  check('oversize: empty after legitimate drain', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 8. Same-timestamp calls do not manufacture tokens.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(1234);
  const b = new TokenBucket(2, 1000, clock);
  check('monotonic: first drain', b.tryRemove(2) === true);
  // No clock advance between calls: no refill regardless of high refill rate.
  check('monotonic: no refill at identical timestamp', b.tryRemove(1) === false);
}

// ---------------------------------------------------------------------------
// 9. Construction anchors lastRefill to the clock's current reading (not 0).
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(5000);
  const b = new TokenBucket(10, 1, clock);
  check('anchor: starts full even when clock > 0', b.tryRemove(10) === true);
  check('anchor: empty right after construction drain', b.tryRemove(1) === false);
  clock.advance(1000); // elapsed measured from 5000, not from 0
  check('anchor: refill measured from construction time', b.tryRemove(1) === true);
}

// ---------------------------------------------------------------------------
// 10. A backward clock jump never penalizes the caller.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(10_000);
  const b = new TokenBucket(5, 1, clock);
  check('backward: initial drain', b.tryRemove(5) === true);
  // Simulate a misbehaving (non-monotonic) clock reading.
  (clock as unknown as { advance(ms: number): void }).advance(-5000);
  check('backward: no negative refill (still empty, not below empty)', b.tryRemove(1) === false);
  // Move forward past the original anchor: refill resumes correctly.
  (clock as unknown as { advance(ms: number): void }).advance(6000); // now 11_000, +1s past anchor
  check('backward: forward progress after a jump still refills', b.tryRemove(1) === true);
}

// ---------------------------------------------------------------------------
// 11. Constructor validation.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  check('validate: capacity 0 throws', throws(() => new TokenBucket(0, 1, clock)));
  check('validate: negative capacity throws', throws(() => new TokenBucket(-1, 1, clock)));
  check('validate: NaN capacity throws', throws(() => new TokenBucket(Number.NaN, 1, clock)));
  check('validate: Infinity capacity throws', throws(() => new TokenBucket(Infinity, 1, clock)));
  check('validate: refillPerSec 0 throws', throws(() => new TokenBucket(1, 0, clock)));
  check('validate: negative refillPerSec throws', throws(() => new TokenBucket(1, -2, clock)));
  check('validate: NaN refillPerSec throws', throws(() => new TokenBucket(1, Number.NaN, clock)));
  check(
    'validate: missing clock throws',
    throws(() => new TokenBucket(1, 1, undefined as unknown as Clock)),
  );
  check('validate: valid args do not throw', !throws(() => new TokenBucket(1, 1, clock)));
}

// ---------------------------------------------------------------------------
// 12. tryRemove argument validation.
// ---------------------------------------------------------------------------
{
  const clock = new MockClock(0);
  const b = new TokenBucket(10, 1, clock);
  check('count: 0 throws', throws(() => b.tryRemove(0)));
  check('count: negative throws', throws(() => b.tryRemove(-1)));
  check('count: fractional throws', throws(() => b.tryRemove(1.5)));
  check('count: NaN throws', throws(() => b.tryRemove(Number.NaN)));
  check('count: Infinity throws', throws(() => b.tryRemove(Infinity)));
  check('count: valid positive integer does not throw', !throws(() => b.tryRemove(1)));
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\nTokenBucket tests: ${passed}/${total} passed.`);
if (failed > 0) {
  console.error(`FAILED (${failed}): ${failures.join(', ')}`);
  process.exit(1);
} else {
  console.log('All checks passed. ✓');
}
