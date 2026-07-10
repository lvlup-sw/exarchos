import { TokenBucket, type Clock } from './impl.ts';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  \u2717 FAIL: ${name}`);
  }
}

function throws(name: string, fn: () => unknown): void {
  try {
    fn();
    failed++;
    console.error(`  \u2717 FAIL: ${name} (expected a throw, got none)`);
  } catch {
    passed++;
  }
}

/**
 * Hermetic, fully-controllable fixture for the Clock seam we own. Because
 * `Clock` is defined by the module under test, this is a contract-faithful
 * fixture rather than an unverified hand-mock of a foreign dependency.
 */
class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** Real monotonic time source, used by the integration rung. */
class RealMonotonicClock implements Clock {
  now(): number {
    return performance.now();
  }
}

function runUnitTests(): void {
  // --- starts full -------------------------------------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(5, 1000, c);
    ok('starts full: tryRemove(capacity) succeeds', b.tryRemove(5) === true);
    ok('empty after draining: tryRemove(1) fails', b.tryRemove(1) === false);
  }

  // --- default count is 1 ------------------------------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(3, 1000, c);
    ok('default count removes 1 (a)', b.tryRemove() === true);
    ok('default count removes 1 (b)', b.tryRemove() === true);
    ok('default count removes 1 (c)', b.tryRemove() === true);
    ok('default count fails when empty', b.tryRemove() === false);
  }

  // --- proportional refill (refillPerSec=1000 => 1 token/ms, exact) ------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(10, 1000, c);
    ok('drain full bucket', b.tryRemove(10) === true);
    ok('bucket now empty', b.tryRemove(1) === false);
    c.advance(3); // +3 tokens
    ok('after 3ms: 4 tokens not available', b.tryRemove(4) === false);
    ok('after 3ms: exactly 3 removable', b.tryRemove(3) === true);
    ok('drained again', b.tryRemove(1) === false);
  }

  // --- sub-token accumulation across calls -------------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(10, 1000, c);
    b.tryRemove(10); // empty
    c.advance(0.5);
    ok('0.5 token < 1 => false', b.tryRemove(1) === false);
    c.advance(0.5); // total 1.0 token accumulated
    ok('accumulated 1.0 token => true', b.tryRemove(1) === true);
  }

  // --- refill is capped at capacity --------------------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(10, 1000, c);
    b.tryRemove(10); // empty
    c.advance(1000); // would add 1000 tokens, but capped at 10
    ok('capped: cannot remove capacity+1', b.tryRemove(11) === false);
    ok('capped: can remove exactly capacity', b.tryRemove(10) === true);
    ok('empty after removing capacity', b.tryRemove(1) === false);
  }

  // --- refill combines with existing balance -----------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(10, 1000, c);
    ok('remove 3 from full', b.tryRemove(3) === true); // 7 left
    c.advance(2); // 9
    ok('9 available: remove 9', b.tryRemove(9) === true); // 0
    ok('empty afterwards', b.tryRemove(1) === false);
  }

  // --- a failed removal consumes nothing ---------------------------------
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(5, 1000, c);
    ok('remove 3 ok', b.tryRemove(3) === true); // 2 left
    ok('remove 3 fails (only 2)', b.tryRemove(3) === false);
    ok('remaining 2 untouched', b.tryRemove(2) === true); // 0
    ok('now empty', b.tryRemove(1) === false);
  }

  // --- count greater than capacity can never succeed, never consumes -----
  {
    const c = new FakeClock(0);
    const b = new TokenBucket(3, 1000, c);
    ok('count > capacity => false', b.tryRemove(5) === false);
    ok('bucket still full after failed oversize request', b.tryRemove(3) === true);
  }

  // --- defensive against a non-monotonic clock ---------------------------
  {
    const c = new FakeClock(100);
    const b = new TokenBucket(5, 1000, c);
    ok('drain', b.tryRemove(5) === true);
    c.set(50); // backwards (contract violation) — must not mint tokens
    ok('backward clock: no refill', b.tryRemove(1) === false);
    c.set(200); // 100ms past the high-water mark (100)
    ok('forward again: refills from high-water mark', b.tryRemove(5) === true);
    ok('empty after', b.tryRemove(1) === false);
  }

  // --- constructor validation --------------------------------------------
  throws('capacity 0 throws', () => new TokenBucket(0, 1, new FakeClock()));
  throws('capacity negative throws', () => new TokenBucket(-1, 1, new FakeClock()));
  throws('capacity NaN throws', () => new TokenBucket(Number.NaN, 1, new FakeClock()));
  throws('capacity Infinity throws', () => new TokenBucket(Number.POSITIVE_INFINITY, 1, new FakeClock()));
  throws('refillPerSec 0 throws', () => new TokenBucket(1, 0, new FakeClock()));
  throws('refillPerSec negative throws', () => new TokenBucket(1, -5, new FakeClock()));
  throws('refillPerSec NaN throws', () => new TokenBucket(1, Number.NaN, new FakeClock()));

  // --- count validation --------------------------------------------------
  {
    const b = new TokenBucket(5, 1000, new FakeClock());
    throws('count 0 throws', () => b.tryRemove(0));
    throws('count negative throws', () => b.tryRemove(-1));
    throws('count fractional throws', () => b.tryRemove(1.5));
    throws('count NaN throws', () => b.tryRemove(Number.NaN));
  }
}

/**
 * High-tier integration rung: exercise the real time seam end-to-end with a
 * genuine monotonic clock and real elapsed wall time (no fakes across the seam).
 * refillPerSec=10 => 0.01 token/ms, so 1 token requires 100ms of real time.
 */
async function runIntegrationTests(): Promise<void> {
  const b = new TokenBucket(100, 10, new RealMonotonicClock());

  ok('integration: starts full, drains 100', b.tryRemove(100) === true);
  ok('integration: immediately empty (sub-100ms elapsed)', b.tryRemove(1) === false);

  await delay(500); // >= 500ms => >= 5 tokens refilled (0.01 token/ms)

  ok('integration: cannot drain full capacity after ~500ms', b.tryRemove(100) === false);
  ok('integration: at least 3 tokens refilled after ~500ms', b.tryRemove(3) === true);
}

async function main(): Promise<void> {
  console.log('TokenBucket verification');
  runUnitTests();
  await runIntegrationTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log('ALL CHECKS PASSED');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
