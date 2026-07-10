import assert from 'node:assert/strict';
import { TokenBucket, type Clock } from './impl.ts';

class ManualClock implements Clock {
  private time = 0;

  now(): number {
    return this.time;
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('ManualClock.advance: cannot move time backwards');
    }
    this.time += ms;
  }
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`FAIL  - ${name}: ${msg}`);
  }
}

test('bucket starts full - can drain exactly capacity tokens immediately', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 1, clock);
  for (let i = 0; i < 5; i++) {
    assert.equal(bucket.tryRemove(1), true, `remove #${i} should succeed`);
  }
  assert.equal(bucket.tryRemove(1), false, 'bucket should be empty now');
});

test('tryRemove defaults to removing 1 token', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(1, 1, clock);
  assert.equal(bucket.tryRemove(), true);
  assert.equal(bucket.tryRemove(), false);
});

test('cannot remove more tokens than capacity even when fully refilled', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(3, 100, clock);
  clock.advance(100_000); // hugely overshoot elapsed time
  assert.equal(bucket.tryRemove(4), false, 'must never exceed capacity');
  assert.equal(bucket.tryRemove(3), true, 'exactly capacity must be removable');
});

test('refill is proportional to elapsed time', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 10, clock); // 10 tokens/sec
  assert.equal(bucket.tryRemove(10), true, 'drain the bucket');
  assert.equal(bucket.tryRemove(1), false, 'empty, should fail');
  clock.advance(500); // 0.5s -> +5 tokens
  assert.equal(bucket.tryRemove(5), true, 'should have exactly 5 tokens');
  assert.equal(bucket.tryRemove(1), false, 'should have 0 tokens left');
});

test('refill never exceeds capacity', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 1000, clock);
  clock.advance(10_000); // would be +10000 tokens if unclamped
  assert.equal(bucket.tryRemove(5), true, 'should be capped at capacity');
  assert.equal(bucket.tryRemove(1), false, 'must not exceed capacity');
});

test('no refill when clock does not advance', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(2, 1, clock);
  assert.equal(bucket.tryRemove(2), true, 'drain to zero');
  assert.equal(bucket.tryRemove(1), false, 'no time passed, still empty');
});

test('lazy refill accumulates correctly across many small steps', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 5, clock); // 5 tokens/sec, capacity 5
  assert.equal(bucket.tryRemove(5), true, 'drain to zero');

  // Advance in 1000 x 1ms increments (rather than one 1000ms jump) to
  // exercise repeated lazy refill computations and guard against
  // floating-point drift accumulating to a false negative.
  for (let i = 0; i < 1000; i++) {
    clock.advance(1);
    bucket.tryRemove(6); // always impossible (> capacity); forces refill only
  }

  assert.equal(
    bucket.tryRemove(5),
    true,
    'should have accumulated ~5 tokens after 1s of 1ms steps',
  );
  assert.equal(bucket.tryRemove(1), false, 'should be empty after removing all 5');
});

test('constructor rejects non-positive or non-finite capacity', () => {
  const clock = new ManualClock();
  assert.throws(() => new TokenBucket(0, 1, clock), RangeError);
  assert.throws(() => new TokenBucket(-1, 1, clock), RangeError);
  assert.throws(() => new TokenBucket(Number.NaN, 1, clock), RangeError);
  assert.throws(() => new TokenBucket(Number.POSITIVE_INFINITY, 1, clock), RangeError);
});

test('constructor rejects non-positive or non-finite refillPerSec', () => {
  const clock = new ManualClock();
  assert.throws(() => new TokenBucket(1, 0, clock), RangeError);
  assert.throws(() => new TokenBucket(1, -5, clock), RangeError);
  assert.throws(() => new TokenBucket(1, Number.NaN, clock), RangeError);
});

test('tryRemove rejects zero, negative, or non-integer count', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(5, 1, clock);
  assert.throws(() => bucket.tryRemove(0), RangeError);
  assert.throws(() => bucket.tryRemove(-1), RangeError);
  assert.throws(() => bucket.tryRemove(1.5), RangeError);
});

test('partial refill supports removing fewer tokens than capacity', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(10, 2, clock); // 2 tokens/sec
  assert.equal(bucket.tryRemove(10), true, 'drain fully');
  clock.advance(2000); // +4 tokens
  assert.equal(bucket.tryRemove(5), false, 'only 4 tokens available');
  assert.equal(bucket.tryRemove(4), true, 'exactly 4 tokens available');
});

test('interleaved consume/refill sequence behaves as expected', () => {
  const clock = new ManualClock();
  const bucket = new TokenBucket(3, 1, clock); // 1 token/sec, capacity 3
  assert.equal(bucket.tryRemove(3), true, 'drain fully');
  assert.equal(bucket.tryRemove(1), false, 'still empty');
  clock.advance(1000); // +1 token
  assert.equal(bucket.tryRemove(1), true);
  assert.equal(bucket.tryRemove(1), false);
  clock.advance(5000); // would be +5, capped at capacity 3
  assert.equal(bucket.tryRemove(3), true);
  assert.equal(bucket.tryRemove(1), false);
});

test('multiple independent buckets do not share state', () => {
  const clockA = new ManualClock();
  const clockB = new ManualClock();
  const a = new TokenBucket(2, 1, clockA);
  const b = new TokenBucket(2, 1, clockB);
  assert.equal(a.tryRemove(2), true);
  assert.equal(a.tryRemove(1), false, 'bucket A drained');
  assert.equal(b.tryRemove(1), true, 'bucket B independent, still has tokens');
  assert.equal(b.tryRemove(1), true);
  assert.equal(b.tryRemove(1), false);
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}
