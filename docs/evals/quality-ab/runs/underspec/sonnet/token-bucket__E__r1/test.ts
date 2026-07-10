import { TokenBucket, type Clock } from './impl.ts';

/** A deterministic, manually-driven Clock — the seam this module contracts against. */
class FakeClock implements Clock {
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
    console.error(`FAIL: ${name}`);
  }
}

function expectThrows(name: string, fn: () => void): void {
  try {
    fn();
    failed++;
    failures.push(`${name} (expected throw, none occurred)`);
    console.error(`FAIL: ${name} (expected throw, none occurred)`);
  } catch {
    passed++;
  }
}

// --- 1. Bucket starts full ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 1, clock);
  check('starts full: can remove all capacity tokens at once', bucket.tryRemove(5));
  check('starts full: empty after removing capacity', !bucket.tryRemove(1));
}

// --- 2. Default count is 1 ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(3, 1, clock);
  check('default count removes 1 token (1st)', bucket.tryRemove());
  check('default count removes 1 token (2nd)', bucket.tryRemove());
  check('default count removes 1 token (3rd)', bucket.tryRemove());
  check('default count: empty on 4th', !bucket.tryRemove());
}

// --- 3. All-or-nothing: a failed attempt does not partially consume ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 1, clock);
  check('over-request fails without consuming', !bucket.tryRemove(6));
  check('all 5 tokens still present after failed over-request', bucket.tryRemove(5));
}

// --- 4. Proportional continuous refill ---
{
  const clock = new FakeClock(0);
  // 10 tokens/sec => 1 token per 100ms
  const bucket = new TokenBucket(10, 10, clock);
  check('drain to empty', bucket.tryRemove(10));
  clock.advance(500); // worth 5 tokens
  check('over-request after partial refill fails', !bucket.tryRemove(6));
  check('exact partial refill amount succeeds', bucket.tryRemove(5));
  check('drained again after consuming exact refill', !bucket.tryRemove(1));
}

// --- 5. Refill caps at capacity (no overflow) ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(3, 100, clock); // fast refill rate
  check('remove 1 leaving 2', bucket.tryRemove(1));
  clock.advance(1_000_000); // huge elapsed time — refill must cap at capacity
  check('cannot remove more than capacity even after huge elapsed time', !bucket.tryRemove(4));
  check('can remove exactly capacity after cap-clamped refill', bucket.tryRemove(3));
  check('empty immediately after removing capped capacity', !bucket.tryRemove(1));
}

// --- 6. Zero elapsed time adds no tokens ---
{
  const clock = new FakeClock(1000);
  const bucket = new TokenBucket(2, 1, clock);
  check('drain bucket', bucket.tryRemove(2));
  check('no refill without elapsed time', !bucket.tryRemove(1));
}

// --- 7. Lazy refill accumulates fractional tokens across failed + successful calls ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(1, 1, clock); // 1 token/sec
  check('drain the single token', bucket.tryRemove(1));
  clock.advance(500);
  check('half a token is not enough', !bucket.tryRemove(1)); // refill still applies on a failed call
  clock.advance(500);
  check('accumulated fractional refill reaches 1 full token', bucket.tryRemove(1));
}

// --- 8. Constructor validation (guard clauses) ---
expectThrows('capacity = 0 throws', () => new TokenBucket(0, 1, new FakeClock()));
expectThrows('capacity negative throws', () => new TokenBucket(-1, 1, new FakeClock()));
expectThrows('capacity NaN throws', () => new TokenBucket(NaN, 1, new FakeClock()));
expectThrows('refillPerSec = 0 throws', () => new TokenBucket(1, 0, new FakeClock()));
expectThrows('refillPerSec negative throws', () => new TokenBucket(1, -5, new FakeClock()));
expectThrows('refillPerSec Infinity throws', () => new TokenBucket(1, Infinity, new FakeClock()));

// --- 9. tryRemove count validation ---
{
  const bucket = new TokenBucket(5, 1, new FakeClock());
  expectThrows('count = 0 throws', () => bucket.tryRemove(0));
  expectThrows('count negative throws', () => bucket.tryRemove(-1));
  expectThrows('count non-integer throws', () => bucket.tryRemove(1.5));
}

// --- 10. Exactly `capacity` single-token removes succeed with a static clock ---
{
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(4, 1, clock);
  let removed = 0;
  for (let i = 0; i < 10; i++) {
    if (bucket.tryRemove(1)) removed++;
  }
  check('exactly `capacity` single-token removes succeed, no more', removed === 4);
}

// --- 11. Integration: real system clock across real elapsed wall-clock time ---
async function realClockIntegrationTest(): Promise<void> {
  const realClock: Clock = { now: () => Date.now() };
  // 20 tokens/sec => 1 token per 50ms
  const bucket = new TokenBucket(1, 20, realClock);

  check('real-clock: drain initial token', bucket.tryRemove(1));
  check('real-clock: immediately empty', !bucket.tryRemove(1));

  await new Promise((resolve) => setTimeout(resolve, 150));

  check(
    'real-clock: token refilled (capped at capacity) after real elapsed time',
    bucket.tryRemove(1),
  );
  check('real-clock: empty again right after', !bucket.tryRemove(1));
}

await realClockIntegrationTest();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFailed checks:\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
