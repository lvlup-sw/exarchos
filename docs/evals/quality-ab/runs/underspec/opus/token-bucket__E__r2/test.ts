import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { TokenBucket, type Clock } from './impl.ts';

/* -------------------------------------------------------------------------- */
/* Tiny assertion harness                                                     */
/* -------------------------------------------------------------------------- */

let total = 0;
let failures = 0;

function check(name: string, cond: boolean, detail?: string): void {
  total++;
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures++;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    Object.is(actual, expected),
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

function expectThrow(name: string, fn: () => unknown): void {
  total++;
  try {
    fn();
    failures++;
    console.error(`  \u2717 ${name} \u2014 expected a throw, none occurred`);
  } catch {
    console.log(`  \u2713 ${name}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Test double for the Clock seam (an interface WE own).                      */
/* -------------------------------------------------------------------------- */

class FakeClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  /** Advance monotonically (rejects going backwards, matching the contract). */
  advance(ms: number): void {
    if (ms < 0) throw new Error('clock is monotonic; cannot go backwards');
    this.t += ms;
  }
}

/** Real monotonic clock — the actual collaborator across the time seam. */
const realClock: Clock = { now: () => performance.now() };

/* -------------------------------------------------------------------------- */
/* Deterministic unit-level behavior (FakeClock)                              */
/* -------------------------------------------------------------------------- */

function unitTests(): void {
  section('starts full and drains');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(5, 1, clock);
    eq('drain full capacity at t0', b.tryRemove(5), true);
    eq('empty bucket rejects', b.tryRemove(1), false);
  }

  section('default count is 1');
  {
    const b = new TokenBucket(3, 1, new FakeClock());
    eq('remove #1', b.tryRemove(), true);
    eq('remove #2', b.tryRemove(), true);
    eq('remove #3', b.tryRemove(), true);
    eq('remove #4 (empty)', b.tryRemove(), false);
  }

  section('cannot remove more than capacity even when full');
  {
    const b = new TokenBucket(5, 10, new FakeClock());
    eq('count > capacity rejected', b.tryRemove(6), false);
    eq('but exact capacity works', b.tryRemove(5), true);
  }

  section('refill is proportional to elapsed time');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 2, clock); // 2 tokens/sec
    eq('drain', b.tryRemove(10), true);
    clock.advance(1000); // +2 tokens
    eq('exactly 2 refilled -> remove 2', b.tryRemove(2), true);
    eq('nothing left', b.tryRemove(1), false);
    clock.advance(500); // +1 token
    eq('half a second -> 1 token', b.tryRemove(1), true);
  }

  section('refill is capped at capacity');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 5, clock);
    eq('drain', b.tryRemove(10), true);
    clock.advance(100_000); // would add 500, capped at 10
    eq('capped -> exactly capacity available', b.tryRemove(10), true);
    eq('not one more than capacity', b.tryRemove(1), false);
  }

  section('bucket never exceeds capacity after long idle from full');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 1, clock);
    clock.advance(50_000); // full already; overflow discarded
    eq('still exactly capacity', b.tryRemove(10), true);
    eq('no bonus tokens', b.tryRemove(1), false);
  }

  section('fractional tokens accumulate continuously across calls');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 1, clock); // 1 token/sec
    eq('drain', b.tryRemove(10), true);
    clock.advance(500); // 0.5 tokens
    eq('0.5 < 1 -> reject', b.tryRemove(1), false);
    clock.advance(500); // now 1.0 tokens
    eq('accumulated to 1.0 -> accept', b.tryRemove(1), true);
  }

  section('elapsed accumulates even without an intervening tryRemove');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 1, clock);
    eq('drain', b.tryRemove(10), true);
    clock.advance(300);
    clock.advance(300);
    clock.advance(500); // total 1100ms -> ~1.1 tokens
    eq('1.1 tokens -> remove 1', b.tryRemove(1), true);
    eq('only ~0.1 left -> reject', b.tryRemove(1), false);
  }

  section('partial consumption then refill');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(10, 1, clock);
    eq('take 4 (10->6)', b.tryRemove(4), true);
    eq('take 4 (6->2)', b.tryRemove(4), true);
    eq('take 4 (2<4)', b.tryRemove(4), false);
    clock.advance(2000); // +2 -> 4
    eq('refilled to 4 -> take 4', b.tryRemove(4), true);
  }

  section('exact boundary uses strict >= (never over-grants)');
  {
    const clock = new FakeClock();
    const b = new TokenBucket(4, 4, clock); // 4 tokens/sec
    eq('drain', b.tryRemove(4), true);
    clock.advance(1000); // exactly 4
    eq('exactly 4 -> take 4', b.tryRemove(4), true);
    eq('nothing over the line', b.tryRemove(1), false);
  }

  section('constructor validation');
  expectThrow('capacity = 0 throws', () => new TokenBucket(0, 1, new FakeClock()));
  expectThrow('capacity < 0 throws', () => new TokenBucket(-1, 1, new FakeClock()));
  expectThrow('capacity NaN throws', () => new TokenBucket(NaN, 1, new FakeClock()));
  expectThrow('refill = 0 throws', () => new TokenBucket(1, 0, new FakeClock()));
  expectThrow('refill < 0 throws', () => new TokenBucket(1, -3, new FakeClock()));
  expectThrow('refill Infinity throws', () => new TokenBucket(1, Infinity, new FakeClock()));

  section('tryRemove argument validation');
  {
    const b = new TokenBucket(10, 1, new FakeClock());
    expectThrow('count = 0 throws', () => b.tryRemove(0));
    expectThrow('count < 0 throws', () => b.tryRemove(-2));
    expectThrow('count non-integer throws', () => b.tryRemove(1.5));
    expectThrow('count NaN throws', () => b.tryRemove(NaN));
  }
}

/* -------------------------------------------------------------------------- */
/* Integration: exercise the real monotonic clock across the seam            */
/* -------------------------------------------------------------------------- */

async function integrationTests(): Promise<void> {
  section('integration: real monotonic clock refills over wall time');
  {
    // 1000 tokens/sec => 1 token/ms; a 30ms sleep refills far past capacity,
    // so the bucket clamps to `capacity` and a full re-drain must succeed.
    const capacity = 10;
    const b = new TokenBucket(capacity, 1000, realClock);
    eq('drain via real clock', b.tryRemove(capacity), true);

    await sleep(30);

    eq('re-drain after real refill', b.tryRemove(capacity), true);
  }

  section('integration: real clock respects capacity cap');
  {
    // Fresh (full) bucket + generous real sleep must not exceed capacity.
    const capacity = 5;
    const b = new TokenBucket(capacity, 1000, realClock);
    await sleep(20);
    eq('capacity still exactly available', b.tryRemove(capacity), true);
    // No negative timing assertion here (sub-ms scheduling jitter is real).
  }

  section('integration: real clock now() is non-decreasing');
  {
    const a = realClock.now();
    await sleep(5);
    const c = realClock.now();
    check('now() advanced (or held)', c >= a, `${c} < ${a}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  unitTests();
  await integrationTests();
}

main()
  .then(() => {
    console.log(`\n${total - failures}/${total} checks passed`);
    if (failures > 0) {
      console.error(`FAILED: ${failures} check(s) did not pass`);
      process.exit(1);
    }
    console.log('ALL PASSED');
  })
  .catch((err: unknown) => {
    console.error('\nFATAL: uncaught error while running tests');
    console.error(err);
    process.exit(1);
  });
