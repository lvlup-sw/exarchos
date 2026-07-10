import { TokenBucket, type Clock } from './impl.ts';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`FAIL: ${name}`);
  }
}

function assertThrows(name: string, fn: () => void): void {
  try {
    fn();
    failed++;
    failures.push(`${name} (expected throw, none occurred)`);
    console.error(`FAIL: ${name} (expected throw, none occurred)`);
  } catch {
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Fake clock: a hermetic fixture for the Clock seam we own, letting tests
// control elapsed time deterministically.
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  private time: number;

  constructor(startMs = 0) {
    this.time = startMs;
  }

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

// ---------------------------------------------------------------------------
// Deterministic behavior tests (fake clock)
// ---------------------------------------------------------------------------

function testStartsFull(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 1, clock);
  check('starts full: can remove full capacity immediately', bucket.tryRemove(10));
  check('empty after full removal: single token fails', !bucket.tryRemove(1));
}

function testDefaultCountIsOne(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 1, clock);
  check('default count removes exactly 1 token', bucket.tryRemove());
  check(
    'four more single-token removals succeed',
    bucket.tryRemove() && bucket.tryRemove() && bucket.tryRemove() && bucket.tryRemove(),
  );
  check('bucket now empty after 5 single removals', !bucket.tryRemove());
}

function testProportionalRefill(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 5, clock); // 5 tokens/sec
  check('drain bucket to zero', bucket.tryRemove(10));
  clock.advance(1000); // 1s elapsed -> 5 tokens
  check('cannot remove 6 tokens when only ~5 have refilled', !bucket.tryRemove(6));
  check('can remove exactly the 5 refilled tokens', bucket.tryRemove(5));
  check('drained again after consuming the refill', !bucket.tryRemove(1));
}

function testRefillCappedAtCapacity(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 5, clock);
  check('consume 1 token, 9 remain', bucket.tryRemove(1));
  clock.advance(1_000_000); // huge idle period
  check('refill never exceeds capacity: cannot remove 11', !bucket.tryRemove(11));
  check('full capacity (10) is available after long idle', bucket.tryRemove(10));
  check('nothing left beyond capacity', !bucket.tryRemove(1));
}

function testFailedRemovalDoesNotConsume(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(3, 1, clock);
  check('cannot remove more than available (4 > 3)', !bucket.tryRemove(4));
  check('all 3 tokens still present after the failed attempt', bucket.tryRemove(3));
}

function testFractionalAccumulationAcrossManySmallSteps(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 10, clock); // 1 token per 100ms
  check('drain bucket', bucket.tryRemove(10));
  for (let i = 0; i < 9; i++) {
    clock.advance(100);
  }
  // 900ms elapsed total -> 10 * 900 / 1000 = 9 tokens
  check('9 tokens accumulated across nine 100ms steps', bucket.tryRemove(9));
  check('drained again after consuming accumulated tokens', !bucket.tryRemove(1));
}

function testPrecisionAtRefillBoundary(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(1, 1, clock); // 1 token/sec, capacity 1
  check('drain the single token', bucket.tryRemove(1));
  clock.advance(999); // just under a full second -> 0.999 tokens
  check('cannot remove 1 token just before full refill', !bucket.tryRemove(1));
  clock.advance(1); // now exactly 1000ms elapsed -> 1.0 token
  check('can remove 1 token exactly at the refill boundary', bucket.tryRemove(1));
}

function testCountExceedingCapacityNeverSucceeds(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 100, clock);
  clock.advance(1_000_000);
  check(
    'a request for more tokens than capacity can never succeed, regardless of elapsed time',
    !bucket.tryRemove(6),
  );
}

function testRepeatedCallsAtSameTimestampGrantNoPhantomRefill(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 1, clock);
  check('drain bucket', bucket.tryRemove(5));
  check(
    'repeated calls with no clock advance stay drained (no phantom refill)',
    !bucket.tryRemove(1) && !bucket.tryRemove(1) && !bucket.tryRemove(1),
  );
}

function testConstructorValidation(): void {
  assertThrows('capacity of 0 is rejected', () => new TokenBucket(0, 1, new FakeClock()));
  assertThrows('negative capacity is rejected', () => new TokenBucket(-5, 1, new FakeClock()));
  assertThrows('refillPerSec of 0 is rejected', () => new TokenBucket(10, 0, new FakeClock()));
  assertThrows('negative refillPerSec is rejected', () => new TokenBucket(10, -1, new FakeClock()));
}

function testTryRemoveCountValidation(): void {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 1, clock);
  assertThrows('tryRemove(0) is rejected (not positive)', () => bucket.tryRemove(0));
  assertThrows('tryRemove(-1) is rejected (not positive)', () => bucket.tryRemove(-1));
  assertThrows('tryRemove(1.5) is rejected (not an integer)', () => bucket.tryRemove(1.5));
}

// ---------------------------------------------------------------------------
// Integration test: a real Clock implementation over real wall-clock time,
// exercising the actual time seam rather than a fake/mock — this is the
// "real collaborator across the seam" exercise for the integration test
// layer of a boundary-touching task.
// ---------------------------------------------------------------------------

class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testRealClockIntegration(): Promise<void> {
  const clock = new RealClock();
  const bucket = new TokenBucket(5, 10, clock); // 10 tokens/sec, capacity 5

  check('integration: bucket starts full against a real clock', bucket.tryRemove(5));
  check('integration: bucket is empty immediately after draining', !bucket.tryRemove(1));

  // 300ms of real wall-clock time at 10 tokens/sec should yield ~3 tokens.
  // setTimeout only guarantees a *minimum* delay, so require just 2 to leave
  // generous slack against scheduler jitter without weakening the assertion
  // that real elapsed time actually drove the refill.
  await sleep(300);
  check(
    'integration: real elapsed time (>= 300ms) refills at least 2 tokens',
    bucket.tryRemove(2),
  );

  // Plenty of real time to fully refill from partial state back to capacity.
  await sleep(1000);
  check(
    'integration: bucket fully refills to capacity given enough real wall-clock time',
    bucket.tryRemove(5),
  );
  check('integration: immediate re-removal fails right after a full drain', !bucket.tryRemove(1));
}

// ---------------------------------------------------------------------------
// Run everything
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testStartsFull();
  testDefaultCountIsOne();
  testProportionalRefill();
  testRefillCappedAtCapacity();
  testFailedRemovalDoesNotConsume();
  testFractionalAccumulationAcrossManySmallSteps();
  testPrecisionAtRefillBoundary();
  testCountExceedingCapacityNeverSucceeds();
  testRepeatedCallsAtSameTimestampGrantNoPhantomRefill();
  testConstructorValidation();
  testTryRemoveCountValidation();

  await testRealClockIntegration();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`Failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error while running tests:', err);
  process.exit(1);
});
