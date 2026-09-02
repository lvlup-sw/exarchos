import { TokenBucket, type Clock } from './impl.ts';

/** Deterministic, manually-driven clock for exercising the time seam. */
class FakeClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
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
  }
}

function expectThrow(name: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(`${name} throws`, threw);
}

// 1. Bucket starts full and drains to empty.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(10, 1, c);
  check('starts full: remove(10)', b.tryRemove(10) === true);
  check('empty after draining: remove(1) false', b.tryRemove(1) === false);
}

// 2. Default count is 1.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(3, 1, c);
  check('default remove 1 (x3)', b.tryRemove() && b.tryRemove() && b.tryRemove());
  check('default remove 4th is false', b.tryRemove() === false);
}

// 3. Continuous, proportional refill.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(10, 2, c); // 2 tokens/sec
  check('drain 10', b.tryRemove(10) === true);
  c.set(250);
  check('250ms -> 0.5 token: remove(1) false', b.tryRemove(1) === false);
  c.set(500);
  check('500ms -> cumulative 1.0 token: remove(1) true', b.tryRemove(1) === true);
  check('consumed back to empty: remove(1) false', b.tryRemove(1) === false);
  c.set(1500);
  check('after +1000ms -> 2 tokens: remove(2) true', b.tryRemove(2) === true);
  check('empty again: remove(1) false', b.tryRemove(1) === false);
}

// 4. Refill is capped at capacity (no unbounded accrual).
{
  const c = new FakeClock(0);
  const b = new TokenBucket(5, 100, c);
  check('drain full 5', b.tryRemove(5) === true);
  c.set(10_000); // uncapped this would be 1000 tokens
  check('capped: remove(5) true', b.tryRemove(5) === true);
  check('capped: remove(1) false (not ~995 left)', b.tryRemove(1) === false);
}

// 5. A full bucket stays capped after a long idle.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(4, 1, c);
  c.set(100_000);
  check('idle full bucket capped: remove(4) then remove(1) false',
    b.tryRemove(4) === true && b.tryRemove(1) === false);
}

// 6. Fractional accrual across sub-refill intervals.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(100, 10, c); // 10/sec
  check('drain 100', b.tryRemove(100) === true);
  c.set(100); // +1.0
  check('100ms -> 1.0 token: remove(1) true', b.tryRemove(1) === true);
  check('empty: remove(1) false', b.tryRemove(1) === false);
  c.set(150); // +0.5 since last update (100ms)
  check('150ms -> 0.5 token: remove(1) false', b.tryRemove(1) === false);
  c.set(250); // +1.0 more -> 1.5 total
  check('250ms -> 1.5 token: remove(1) true', b.tryRemove(1) === true);
}

// 7. Lazy (single-jump) vs eager (many-step) refill are equivalent.
{
  const c1 = new FakeClock(0);
  const b1 = new TokenBucket(1000, 100, c1); // 1 token / 10ms
  b1.tryRemove(1000);
  c1.set(1000);
  let eager = 0;
  while (b1.tryRemove(1)) eager++;
  check('single 1000ms jump yields 100 tokens', eager === 100);

  const c2 = new FakeClock(0);
  const b2 = new TokenBucket(1000, 100, c2);
  b2.tryRemove(1000);
  let lazy = 0;
  for (let t = 10; t <= 1000; t += 10) {
    c2.set(t);
    if (b2.tryRemove(1)) lazy++;
  }
  check('100 x 10ms steps yield 100 successful removes', lazy === 100);
}

// 8. count > capacity always fails, without disturbing the bucket.
{
  const c = new FakeClock(0);
  const b = new TokenBucket(5, 1, c);
  check('remove(10) with capacity 5 -> false', b.tryRemove(10) === false);
  check('bucket untouched: remove(5) still true', b.tryRemove(5) === true);
}

// 9. Defensive handling of a non-monotonic (backwards) clock.
{
  const c = new FakeClock(1000);
  const b = new TokenBucket(10, 5, c);
  check('drain at t=1000', b.tryRemove(10) === true);
  c.set(500); // backwards: must not credit tokens
  check('backwards clock credits nothing: remove(1) false', b.tryRemove(1) === false);
  c.set(1000); // back to reference: still zero elapsed vs high-water mark
  check('return to reference: remove(1) false', b.tryRemove(1) === false);
  c.set(1200); // +200ms past reference -> 1.0 token
  check('forward past reference refills: remove(1) true', b.tryRemove(1) === true);
}

// 10. Constructor argument validation.
expectThrow('capacity 0', () => new TokenBucket(0, 1, new FakeClock()));
expectThrow('capacity negative', () => new TokenBucket(-5, 1, new FakeClock()));
expectThrow('capacity NaN', () => new TokenBucket(Number.NaN, 1, new FakeClock()));
expectThrow('capacity Infinity', () => new TokenBucket(Number.POSITIVE_INFINITY, 1, new FakeClock()));
expectThrow('refillPerSec 0', () => new TokenBucket(10, 0, new FakeClock()));
expectThrow('refillPerSec negative', () => new TokenBucket(10, -1, new FakeClock()));
expectThrow('refillPerSec NaN', () => new TokenBucket(10, Number.NaN, new FakeClock()));

// 11. tryRemove count validation.
{
  const b = new TokenBucket(10, 1, new FakeClock());
  expectThrow('count 0', () => b.tryRemove(0));
  expectThrow('count negative', () => b.tryRemove(-1));
  expectThrow('count fractional', () => b.tryRemove(1.5));
  expectThrow('count NaN', () => b.tryRemove(Number.NaN));
}

// ---- summary ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('All TokenBucket checks passed.');
