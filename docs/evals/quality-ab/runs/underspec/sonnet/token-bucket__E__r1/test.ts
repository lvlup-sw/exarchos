import { TokenBucket, type Clock } from './impl.ts';

interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}

const results: TestResult[] = [];

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

function record(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function recordAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Deterministic, manually-advanced clock — this is the seam we own. */
class FakeClock implements Clock {
  private t = 0;

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

async function main(): Promise<void> {
  record('starts full and allows draining exactly capacity, then denies more', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(5, 1, clock);
    assert(bucket.tryRemove(5) === true, 'expected full bucket to allow removing exactly capacity tokens');
    assert(bucket.tryRemove(1) === false, 'expected empty bucket to deny removal with no elapsed time');
  });

  record('tryRemove defaults to removing a single token', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(1, 1, clock);
    assert(bucket.tryRemove() === true, 'default call should remove 1 token from a full bucket');
    assert(bucket.tryRemove() === false, 'no tokens left, default remove of 1 should fail');
  });

  record('constructor rejects non-positive capacity', () => {
    const clock = new FakeClock();
    assertThrows(() => new TokenBucket(0, 1, clock), 'capacity=0 should throw');
    assertThrows(() => new TokenBucket(-5, 1, clock), 'negative capacity should throw');
    assertThrows(() => new TokenBucket(Number.NaN, 1, clock), 'NaN capacity should throw');
  });

  record('constructor rejects non-positive refillPerSec', () => {
    const clock = new FakeClock();
    assertThrows(() => new TokenBucket(5, 0, clock), 'refillPerSec=0 should throw');
    assertThrows(() => new TokenBucket(5, -1, clock), 'negative refillPerSec should throw');
    assertThrows(() => new TokenBucket(5, Number.NaN, clock), 'NaN refillPerSec should throw');
  });

  record('tryRemove rejects invalid count', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(5, 1, clock);
    assertThrows(() => bucket.tryRemove(0), 'count=0 should throw');
    assertThrows(() => bucket.tryRemove(-1), 'negative count should throw');
    assertThrows(() => bucket.tryRemove(1.5), 'non-integer count should throw');
    assertThrows(() => bucket.tryRemove(Number.NaN), 'NaN count should throw');
  });

  record('a denied tryRemove does not consume any tokens', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 1, clock);
    assert(bucket.tryRemove(2) === true, 'should remove 2 of 3 available tokens');
    // 1 token remains; a request for 2 must fail without touching the 1 that remains.
    assert(bucket.tryRemove(2) === false, 'insufficient tokens for a request of 2');
    assert(bucket.tryRemove(1) === true, 'the 1 remaining token must still be available');
  });

  record('refill is proportional to elapsed time and accumulates lazily across calls', () => {
    const clock = new FakeClock();
    // capacity=1, refillPerSec=2 => 1 token every 500ms.
    const bucket = new TokenBucket(1, 2, clock);

    assert(bucket.tryRemove(1) === true, 'drain the initial full token');

    clock.advance(200); // adds 2 * 0.2 = 0.4 tokens
    assert(bucket.tryRemove(1) === false, '0.4 tokens is not enough to remove 1');

    clock.advance(300); // adds 2 * 0.3 = 0.6 tokens; total now 0.4 + 0.6 = 1.0
    assert(bucket.tryRemove(1) === true, '0.4 + 0.6 accumulated across two lazy refills should reach 1.0');
  });

  record('refill never exceeds capacity even after a very long elapsed time', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(3, 100, clock);

    assert(bucket.tryRemove(3) === true, 'drain the full bucket');
    clock.advance(100_000); // would be 10,000 tokens uncapped; must cap at capacity=3
    assert(bucket.tryRemove(3) === true, 'bucket should refill up to (but not past) capacity');
    assert(bucket.tryRemove(1) === false, 'no tokens should remain beyond the capacity cap');
  });

  record('sequential drain/refill/drain cycles behave as an ongoing rate limiter', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 5, clock); // 5 tokens/sec

    assert(bucket.tryRemove(10) === true, 'drain the initial full bucket');

    clock.advance(1000); // +5 tokens
    assert(bucket.tryRemove(5) === true, 'exactly 5 tokens available after 1s at 5/sec');
    assert(bucket.tryRemove(1) === false, 'nothing left immediately after draining the refill');

    clock.advance(200); // +1 token
    assert(bucket.tryRemove(1) === true, '0.2s at 5/sec yields exactly 1 token');
    assert(bucket.tryRemove(1) === false, 'no tokens left after consuming the single refilled token');
  });

  // --- High-tier integration coverage: exercise the real wall-clock collaborator, ---
  // --- not just the deterministic fake we author for unit isolation.             ---

  await recordAsync('exercises the real system clock as the Clock collaborator', async () => {
    const realClock: Clock = { now: () => Date.now() };
    const bucket = new TokenBucket(2, 10, realClock); // 10 tokens/sec => 100ms per token

    assert(bucket.tryRemove(2) === true, 'expected full bucket to drain at start');
    assert(bucket.tryRemove(1) === false, 'expected empty bucket to deny immediately after drain');

    await new Promise((resolve) => setTimeout(resolve, 150));

    assert(
      bucket.tryRemove(1) === true,
      'expected >=1 token to have refilled after a real 150ms wait at 10 tokens/sec',
    );
    assert(
      bucket.tryRemove(2) === false,
      'expected capacity(2) not to be exceeded after a single short real-time wait',
    );
  });

  await recordAsync('real clock: refill caps at capacity even after a longer real wait', async () => {
    const realClock: Clock = { now: () => Date.now() };
    const bucket = new TokenBucket(1, 20, realClock); // 20 tokens/sec, capacity 1

    assert(bucket.tryRemove(1) === true, 'drain the single starting token');

    await new Promise((resolve) => setTimeout(resolve, 200)); // would be ~4 tokens uncapped

    assert(bucket.tryRemove(1) === true, 'one token should be available after the real wait');
    assert(
      bucket.tryRemove(1) === false,
      'no more than capacity(1) should be available even after a generous real wait',
    );
  });

  // --- Summary ---

  for (const r of results) {
    const line = `${r.pass ? 'PASS' : 'FAIL'} - ${r.name}`;
    console.log(r.error ? `${line}\n       ${r.error}` : line);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} tests passed`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error running test suite:', err);
  process.exit(1);
});
