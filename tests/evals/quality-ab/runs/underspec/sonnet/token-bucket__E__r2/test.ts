import { TokenBucket } from './impl.ts';
import type { Clock } from './impl.ts';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name}`);
  }
}

function expectThrows(name: string, fn: () => void): void {
  try {
    fn();
    failed++;
    failures.push(name);
    console.error(`  FAIL: ${name} (expected throw, none occurred)`);
  } catch {
    passed++;
    console.log(`  PASS: ${name}`);
  }
}

/** Controllable time source — this is the seam TokenBucket owns and injects. */
class FakeClock implements Clock {
  private time = 0;
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

console.log('Unit tests (FakeClock seam):');

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(5, 1, clock);
  for (let i = 0; i < 5; i++) {
    check(`starts full: remove #${i + 1} succeeds`, bucket.tryRemove());
  }
  check('starts full: 6th remove fails once drained', !bucket.tryRemove());
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(10, 5, clock); // 5 tokens/sec
  check('drain all 10 tokens', bucket.tryRemove(10));
  check('empty right after drain', !bucket.tryRemove(1));

  clock.advance(200); // 5 * 200 / 1000 = 1.0 token
  check(
    'refill after 200ms grants exactly 1 token (next remove fails)',
    bucket.tryRemove(1) && !bucket.tryRemove(1),
  );
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(10, 5, clock);
  bucket.tryRemove(10); // drain to 0
  clock.advance(3000); // would be 15 tokens uncapped; capacity is 10
  check(
    'refill is capped at capacity, not unbounded',
    bucket.tryRemove(10) && !bucket.tryRemove(1),
  );
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(3, 10, clock);
  check('request larger than capacity is rejected even when full', !bucket.tryRemove(4));
  check(
    'a rejected request does not partially consume tokens',
    bucket.tryRemove(3),
  );
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(10, 2, clock); // 2 tokens/sec
  bucket.tryRemove(10);
  clock.advance(1000); // +2 tokens => 2 available
  check('partial refill: request for 3 fails when only 2 available', !bucket.tryRemove(3));
  check('partial refill: request for exactly 2 succeeds', bucket.tryRemove(2));
  check('bucket is empty again after consuming the partial refill', !bucket.tryRemove(1));
}

{
  // Refill is lazy: it is computed only when tryRemove is called, so two
  // clock advances with no intervening call accumulate into one credit.
  const clock = new FakeClock();
  const bucket = new TokenBucket(10, 10, clock); // 0.01 token/ms
  bucket.tryRemove(10);
  clock.advance(50);
  clock.advance(50); // 100ms total since last tryRemove => 1.0 token
  check(
    'lazily-accumulated elapsed time refills correctly on next call',
    bucket.tryRemove(1) && !bucket.tryRemove(1),
  );
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(5, 5, clock);
  bucket.tryRemove(5);
  check('zero elapsed clock time yields no refill', !bucket.tryRemove(1));
}

{
  const clock = new FakeClock();
  const bucket = new TokenBucket(1, 1, clock);
  check('default count removes exactly 1 token', bucket.tryRemove());
  check('bucket empty after default-count removal', !bucket.tryRemove());
}

{
  // Fractional capacity is permitted (spec only requires > 0).
  const clock = new FakeClock();
  const bucket = new TokenBucket(2.5, 1, clock);
  check('fractional capacity: remove 2 succeeds', bucket.tryRemove(2));
  check('fractional capacity: remaining 0.5 cannot satisfy a request for 1', !bucket.tryRemove(1));
}

{
  const clock = new FakeClock();
  expectThrows('capacity must be > 0 (zero rejected)', () => new TokenBucket(0, 1, clock));
  expectThrows('capacity must be > 0 (negative rejected)', () => new TokenBucket(-1, 1, clock));
  expectThrows('refillPerSec must be > 0 (zero rejected)', () => new TokenBucket(5, 0, clock));
  expectThrows('refillPerSec must be > 0 (negative rejected)', () => new TokenBucket(5, -2, clock));
  expectThrows('capacity must be finite', () => new TokenBucket(Infinity, 1, clock));
  expectThrows('refillPerSec must be finite', () => new TokenBucket(5, Infinity, clock));

  const bucket = new TokenBucket(5, 1, clock);
  expectThrows('count must be positive (zero rejected)', () => bucket.tryRemove(0));
  expectThrows('count must be positive (negative rejected)', () => bucket.tryRemove(-1));
  expectThrows('count must be an integer', () => bucket.tryRemove(1.5));
  expectThrows('count must not be NaN', () => bucket.tryRemove(Number.NaN));
}

// --- Integration test: real system clock + real timers ---
// Exercises the actual injected-Clock seam against wall-clock time passing,
// not just a hand-rolled fake, per the high-tier integration rung.

console.log('Integration tests (real Date.now() clock + real timers):');

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIntegrationTests(): Promise<void> {
  const clock = new SystemClock();
  const bucket = new TokenBucket(5, 20, clock); // 20 tokens/sec => 1 token / 50ms

  check('integration: starts full (drain all 5)', bucket.tryRemove(5));
  check('integration: empty immediately after drain', !bucket.tryRemove(1));

  await sleep(120); // real wall-clock wait; expect >= ~2.4 tokens refilled

  check('integration: real elapsed time refills at least 2 tokens', bucket.tryRemove(2));

  await sleep(1000); // plenty of real time to refill well past capacity

  check(
    'integration: refill after a long real wait is capped at capacity',
    bucket.tryRemove(5) && !bucket.tryRemove(1),
  );
}

runIntegrationTests()
  .then(() => {
    console.log('');
    console.log(`Total: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error(`Failing checks: ${failures.join(', ')}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('Unexpected error while running tests:', err);
    process.exit(1);
  });
