import { TokenBucket, type Clock } from './impl.ts';

/**
 * Hermetic, contract-verified fixture for the ONE dependency this module owns:
 * the {@link Clock} seam declared in impl.ts. It is deterministic and monotonic
 * (matching the interface's contract), which lets the tests below drive the real
 * `TokenBucket` across the real seam exactly as production would — production
 * merely substitutes `Date.now`/`performance.now` for this stepped counter.
 */
class FakeClock implements Clock {
  private t: number;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  /** Advance simulated time; refuses to move backwards (honors monotonicity). */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('FakeClock cannot go backwards');
    }
    this.t += ms;
  }
}

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.error(`\u2717 ${name} \u2014 ${msg}`);
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
  if (!threw) {
    throw new Error(`expected throw: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

test('starts full and cannot over-draw without time passing', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 1, clock);

  assert(bucket.tryRemove(5) === true, 'should drain a full bucket');
  assert(bucket.tryRemove(1) === false, 'should be empty immediately after full drain');
});

test('default count is 1', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(2, 1, clock);

  assert(bucket.tryRemove() === true, 'first default removal');
  assert(bucket.tryRemove() === true, 'second default removal');
  assert(bucket.tryRemove() === false, 'third default removal exhausts bucket');
});

test('refills proportionally to elapsed time', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 10, clock); // 10 tokens/sec

  assert(bucket.tryRemove(10) === true, 'drain full bucket');
  clock.advance(500); // +5 tokens
  assert(bucket.tryRemove(5) === true, '5 tokens available after 500ms');
  assert(bucket.tryRemove(1) === false, 'nothing left after consuming the refill');

  clock.advance(100); // +1 token
  assert(bucket.tryRemove(1) === true, '1 token available after a further 100ms');
});

test('refill is capped at capacity (overflow is discarded)', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 100, clock);

  assert(bucket.tryRemove(10) === true, 'drain');
  clock.advance(10_000); // would add 1000 tokens; must cap at 10
  assert(bucket.tryRemove(10) === true, 'refilled back to capacity');
  assert(bucket.tryRemove(1) === false, 'no tokens beyond capacity were retained');
});

test('refill is lazy — no tokens without a tryRemove call, then applied in one shot', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(3, 1, clock);

  assert(bucket.tryRemove(3) === true, 'drain');
  // Advance a long way without calling tryRemove; the credit is applied on the
  // next call from the construction/last-refill baseline.
  clock.advance(3000);
  assert(bucket.tryRemove(3) === true, 'lazily credited to capacity on next call');
});

test('boundary: just-under vs exactly-enough elapsed time', () => {
  const under = new FakeClock(0);
  const b1 = new TokenBucket(10, 1, under); // 1 token/sec
  assert(b1.tryRemove(10) === true, 'drain');
  under.advance(999); // 0.999 tokens
  assert(b1.tryRemove(1) === false, '0.999 tokens is not enough for 1');

  const exact = new FakeClock(0);
  const b2 = new TokenBucket(10, 1, exact);
  assert(b2.tryRemove(10) === true, 'drain');
  exact.advance(1000); // exactly 1 token
  assert(b2.tryRemove(1) === true, '1000ms yields exactly one token');
});

test('floating-point accumulation does not spuriously reject at boundaries', () => {
  // Summing 0.1 ten times underflows to 0.9999999999999999 in IEEE-754.
  // A full second must still grant exactly one token.
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 1, clock); // 1 token/sec

  assert(bucket.tryRemove(10) === true, 'drain');

  let grants = 0;
  for (let i = 0; i < 10; i++) {
    clock.advance(100); // +0.1 token each; triggers a refill step
    if (bucket.tryRemove(1)) {
      grants++;
    }
  }

  assert(
    grants === 1,
    `expected exactly one grant once a full second elapsed, got ${grants}`,
  );
});

test('count greater than capacity always fails and consumes nothing', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(3, 5, clock);

  assert(bucket.tryRemove(5) === false, 'cannot remove more than capacity');
  assert(bucket.tryRemove(3) === true, 'full capacity still available (nothing consumed)');
});

test('refill baseline is captured at construction, not absolute clock time', () => {
  const clock = new FakeClock(5000); // non-zero start
  const bucket = new TokenBucket(2, 1, clock); // 1 token/sec

  assert(bucket.tryRemove(2) === true, 'drain');
  clock.advance(1000); // 1000ms elapsed -> +1 token (NOT 6 tokens from absolute 6000ms)
  assert(bucket.tryRemove(1) === true, 'one token after 1000ms');
  assert(bucket.tryRemove(1) === false, 'not two — absolute time must not leak in');
});

test('repeated calls at the same timestamp add no tokens', () => {
  const clock = new FakeClock(1234);
  const bucket = new TokenBucket(2, 1000, clock);

  assert(bucket.tryRemove(2) === true, 'drain');
  assert(bucket.tryRemove(1) === false, 'no time passed, no refill (1st)');
  assert(bucket.tryRemove(1) === false, 'no time passed, no refill (2nd)');
});

test('constructor validates its arguments', () => {
  const clock = new FakeClock(0);
  assertThrows(() => new TokenBucket(0, 1, clock), 'capacity 0');
  assertThrows(() => new TokenBucket(-1, 1, clock), 'capacity negative');
  assertThrows(() => new TokenBucket(Number.NaN, 1, clock), 'capacity NaN');
  assertThrows(() => new TokenBucket(Number.POSITIVE_INFINITY, 1, clock), 'capacity Infinity');
  assertThrows(() => new TokenBucket(1, 0, clock), 'refill 0');
  assertThrows(() => new TokenBucket(1, -1, clock), 'refill negative');
  assertThrows(() => new TokenBucket(1, Number.NaN, clock), 'refill NaN');
  // Unowned/malformed clock contract must be rejected up front.
  assertThrows(
    () => new TokenBucket(1, 1, undefined as unknown as Clock),
    'missing clock',
  );
  assertThrows(
    () => new TokenBucket(1, 1, {} as unknown as Clock),
    'clock without now()',
  );
});

test('tryRemove validates count', () => {
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(10, 1, clock);

  assertThrows(() => bucket.tryRemove(0), 'count 0');
  assertThrows(() => bucket.tryRemove(-1), 'count negative');
  assertThrows(() => bucket.tryRemove(1.5), 'count non-integer');
  assertThrows(() => bucket.tryRemove(Number.NaN), 'count NaN');
  // A rejected call must not have consumed anything.
  assert(bucket.tryRemove(10) === true, 'bucket untouched by invalid calls');
});

test('integration: steady sustained-rate throttling across the clock seam', () => {
  // Exercise the real TokenBucket driven by the real Clock seam over a realistic
  // sequence: capacity 5, 5 tokens/sec => ~1 token every 200ms once drained.
  const clock = new FakeClock(0);
  const bucket = new TokenBucket(5, 5, clock);

  // Burst: capacity allows exactly 5 immediate removals.
  let burst = 0;
  while (bucket.tryRemove(1)) {
    burst++;
  }
  assert(burst === 5, `burst should equal capacity, got ${burst}`);

  // Drive 3 seconds in 100ms ticks; long-run grants should track refillPerSec.
  let sustained = 0;
  for (let i = 0; i < 30; i++) {
    clock.advance(100);
    if (bucket.tryRemove(1)) {
      sustained++;
    }
  }
  // 3s at 5 tokens/sec ~= 15 grants; allow +/-1 for boundary alignment.
  assert(
    sustained >= 14 && sustained <= 16,
    `sustained grants over 3s should be ~15, got ${sustained}`,
  );
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILURES:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
