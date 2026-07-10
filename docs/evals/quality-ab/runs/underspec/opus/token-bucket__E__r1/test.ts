import { TokenBucket, type Clock } from './impl.ts';

/**
 * Deterministic, hermetic clock. This is the injected seam we OWN (the `Clock`
 * contract is defined in impl.ts), so a controllable fixture is the correct way
 * to exercise time-dependent behavior — no wall-clock, no flakiness.
 */
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
    console.error(`  ✗ ${name}`);
  }
}

function throws(name: string, fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(name, threw);
}

/** Runs a scenario, turning any unexpected throw into a recorded failure. */
function scenario(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name} (unexpected throw: ${msg})`);
    console.error(`  ✗ ${name} — unexpected throw: ${msg}`);
  }
}

scenario('bucket starts full', () => {
  const clk = new FakeClock(1000);
  const b = new TokenBucket(10, 5, clk);
  check('starts full: consume entire capacity', b.tryRemove(10) === true);
  check('starts full: empty immediately after', b.tryRemove(1) === false);
});

scenario('default count is 1', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(3, 1, clk);
  check('default consumes 1 (a)', b.tryRemove() === true);
  check('default consumes 1 (b)', b.tryRemove() === true);
  check('default consumes 1 (c)', b.tryRemove() === true);
  check('default: empty after 3 removals', b.tryRemove() === false);
});

scenario('failed removal does not consume tokens', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 1, clk);
  check('remove 5 succeeds', b.tryRemove(5) === true); // 5 left
  check('remove 6 fails', b.tryRemove(6) === false); // untouched, still 5
  check('remove 5 still succeeds', b.tryRemove(5) === true); // 0 left
  check('empty afterwards', b.tryRemove(1) === false);
});

scenario('refill is continuous and proportional', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 10, clk); // 10 tok/s => 1 tok / 100ms
  check('drain full bucket', b.tryRemove(10) === true);
  clk.advance(500); // +5.0 tokens
  check('exactly 5 tokens after 500ms', b.tryRemove(5) === true);
  check('no 6th token available', b.tryRemove(1) === false);
  clk.advance(100); // +1.0 token
  check('one more token after another 100ms', b.tryRemove(1) === true);
});

scenario('fractional refill accumulates across calls', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 10, clk); // 0.5 tok / 50ms
  check('drain', b.tryRemove(10) === true);
  clk.advance(50); // +0.5 (fractional)
  check('half a token is not enough', b.tryRemove(1) === false);
  clk.advance(50); // +0.5 => 1.0 accumulated
  check('accumulated fractions now suffice', b.tryRemove(1) === true);
  check('empty again', b.tryRemove(1) === false);
});

scenario('no double-counting when the clock does not advance', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 10, clk);
  check('drain', b.tryRemove(10) === true);
  clk.advance(100); // +1.0
  check('one token after 100ms', b.tryRemove(1) === true);
  check('no free refill without elapsed time', b.tryRemove(1) === false);
});

scenario('refill is capped at capacity', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 10, clk);
  check('drain', b.tryRemove(10) === true);
  clk.advance(1_000_000); // would be 10,000 tokens uncapped
  check('capacity available after long idle', b.tryRemove(10) === true);
  check('never exceeds capacity', b.tryRemove(1) === false);
});

scenario('count larger than capacity always fails', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(5, 100, clk);
  check('over-capacity request fails even when full', b.tryRemove(6) === false);
  check('full bucket left intact', b.tryRemove(5) === true);
});

scenario('constructor validates its arguments', () => {
  const clk = new FakeClock(0);
  throws('capacity 0 throws', () => new TokenBucket(0, 1, clk));
  throws('capacity negative throws', () => new TokenBucket(-1, 1, clk));
  throws('capacity NaN throws', () => new TokenBucket(NaN, 1, clk));
  throws('capacity Infinity throws', () => new TokenBucket(Infinity, 1, clk));
  throws('refillPerSec 0 throws', () => new TokenBucket(10, 0, clk));
  throws('refillPerSec negative throws', () => new TokenBucket(10, -5, clk));
  throws('refillPerSec NaN throws', () => new TokenBucket(10, NaN, clk));
});

scenario('tryRemove validates count', () => {
  const clk = new FakeClock(0);
  const b = new TokenBucket(10, 1, clk);
  throws('count 0 throws', () => b.tryRemove(0));
  throws('count negative throws', () => b.tryRemove(-1));
  throws('count fractional throws', () => b.tryRemove(1.5));
  throws('count NaN throws', () => b.tryRemove(NaN));
});

scenario('integration: burst then sustained rate across the clock seam', () => {
  // Exercises the full TokenBucket <-> Clock collaboration over many steps.
  const clk = new FakeClock(0);
  const b = new TokenBucket(5, 5, clk); // 5 tok/s => 1 tok / 200ms

  // Initial burst drains the full capacity.
  for (let i = 0; i < 5; i++) {
    check(`burst token ${i}`, b.tryRemove(1) === true);
  }
  check('burst exhausted', b.tryRemove(1) === false);

  // Then exactly one token becomes available every 200ms window.
  let allowed = 0;
  for (let step = 0; step < 10; step++) {
    clk.advance(200);
    if (b.tryRemove(1)) allowed++;
    check(
      `only one token per 200ms window ${step}`,
      b.tryRemove(1) === false,
    );
  }
  check('sustained rate delivered exactly 10 tokens', allowed === 10);
});

console.log(`\nTokenBucket tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED checks: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('ALL PASS');
