import { TokenBucket, type Clock } from './impl.ts';

interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({
      name,
      pass: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    throw new Error(msg);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

class ManualClock implements Clock {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('starts full: capacity tokens available immediately', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 1, clock);
  for (let i = 0; i < 10; i++) {
    assert(bucket.tryRemove(1), `expected removal ${i + 1} to succeed`);
  }
  assert(!bucket.tryRemove(1), 'expected 11th removal to fail (bucket empty)');
});

test('tryRemove defaults count to 1', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(1, 1, clock);
  assert(bucket.tryRemove(), 'default removal of 1 should succeed on full bucket');
  assert(!bucket.tryRemove(), 'second default removal should fail (empty)');
});

test('tryRemove(n) removes multiple tokens atomically', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 1, clock);
  assert(bucket.tryRemove(3), 'remove 3 of 5 should succeed');
  assert(!bucket.tryRemove(3), 'remove 3 more (only 2 left) should fail');
  assert(bucket.tryRemove(2), 'remove remaining 2 should succeed');
});

test('failed tryRemove does not consume tokens', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(3, 1, clock);
  assert(!bucket.tryRemove(5), 'removal exceeding available tokens should fail');
  assert(bucket.tryRemove(3), 'all 3 tokens should still be present after failed removal');
});

test('refill is proportional to elapsed time', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 2, clock); // 2 tokens/sec
  for (let i = 0; i < 10; i++) bucket.tryRemove(1);
  assert(!bucket.tryRemove(1), 'bucket should be empty');

  clock.advance(500); // 0.5s * 2/s = 1 token
  assert(bucket.tryRemove(1), 'expected 1 token after 500ms at 2 tokens/sec');
  assert(!bucket.tryRemove(1), 'should be empty again immediately after');
});

test('refill caps at capacity (no overflow)', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 10, clock); // fast refill
  bucket.tryRemove(1); // consume 1, 4 left

  clock.advance(10_000); // would overflow to 100+ tokens if uncapped
  assert(bucket.tryRemove(5), 'bucket should cap at capacity=5, not overflow');
  assert(!bucket.tryRemove(1), 'no more than capacity tokens should ever be available');
});

test('continuous fractional refill accumulates correctly across multiple calls', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 1, clock); // 1 token/sec
  for (let i = 0; i < 10; i++) bucket.tryRemove(1);
  assert(!bucket.tryRemove(1), 'bucket should be empty');

  // Advance in small increments; total 3000ms should yield 3 tokens.
  for (let i = 0; i < 30; i++) clock.advance(100);

  assert(bucket.tryRemove(1), 'token 1 of 3 should be available');
  assert(bucket.tryRemove(1), 'token 2 of 3 should be available');
  assert(bucket.tryRemove(1), 'token 3 of 3 should be available');
  assert(!bucket.tryRemove(1), 'no 4th token should be available');
});

test('zero elapsed time between calls does not double-refill', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(2, 1, clock);
  bucket.tryRemove(2); // drain to empty
  assert(!bucket.tryRemove(1), 'expect empty at same timestamp');
  assert(!bucket.tryRemove(1), 'still empty at same timestamp, second check');
});

test('bucket never exceeds capacity even without ever draining', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(4, 1, clock);
  clock.advance(100_000); // long time passes while already full
  assert(bucket.tryRemove(4), 'still only capacity=4 tokens available');
  assert(!bucket.tryRemove(1), 'no extra tokens accrued while already full');
});

test('constructor rejects non-positive capacity', () => {
  const clock = new ManualClock();
  assertThrows(() => new TokenBucket(0, 1, clock), 'capacity=0 should throw');
  assertThrows(() => new TokenBucket(-5, 1, clock), 'negative capacity should throw');
  assertThrows(() => new TokenBucket(Number.NaN, 1, clock), 'NaN capacity should throw');
});

test('constructor rejects non-positive refillPerSec', () => {
  const clock = new ManualClock();
  assertThrows(() => new TokenBucket(10, 0, clock), 'refillPerSec=0 should throw');
  assertThrows(() => new TokenBucket(10, -1, clock), 'negative refillPerSec should throw');
});

test('tryRemove rejects non-positive or non-integer count', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 1, clock);
  assertThrows(() => bucket.tryRemove(0), 'count=0 should throw');
  assertThrows(() => bucket.tryRemove(-1), 'negative count should throw');
  assertThrows(() => bucket.tryRemove(1.5), 'non-integer count should throw');
});

test('requesting more than capacity always fails, even fully refilled', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(3, 100, clock);
  clock.advance(1_000_000);
  assert(!bucket.tryRemove(4), 'request exceeding capacity must always fail');
});

test('clock is only read via injected Clock, not wall-clock', () => {
  let calls = 0;
  const clock: Clock = {
    now: () => {
      calls += 1;
      return calls * 1000; // 1 "second" per call
    },
  };
  const bucket = new TokenBucket(5, 1, clock);
  assert(calls >= 1, 'constructor should read time from the injected clock at least once');

  const before = calls;
  bucket.tryRemove(1);
  assert(calls > before, 'tryRemove should consult the injected clock, not Date.now()/perf');
});

test('mixed sequence: drain, partial refill, drain again', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(6, 3, clock); // 3 tokens/sec

  assert(bucket.tryRemove(6), 'drain full bucket');
  clock.advance(1000); // +3 tokens
  assert(bucket.tryRemove(3), 'consume the 3 refilled tokens');
  assert(!bucket.tryRemove(1), 'no tokens left');

  clock.advance(2000); // +6 tokens, capped at capacity 6
  assert(bucket.tryRemove(6), 'fully refilled after 2s at 3/sec, capped at capacity 6');
  assert(!bucket.tryRemove(1), 'nothing left after draining the cap');
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const r of results) {
  const status = r.pass ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${r.name}${r.error ? ` — ${r.error}` : ''}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);

if (failed.length > 0) {
  console.error(`${failed.length} test(s) failed.`);
  process.exit(1);
}
