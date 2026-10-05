/**
 * Hidden oracle. The agent under test never sees this file. The oracle grades `impl.ts` against the edge cases of the spec.
 * Run `tsx oracle.ts` in a directory that holds the `impl.ts` to grade.
 */
import { TokenBucket, type Clock } from './impl.ts';

class FakeClock implements Clock {
  constructor(public t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const checks: Array<[string, () => void]> = [
  [
    'starts full: capacity tokens available at t=0',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(5, 1, c);
      assert(b.tryRemove(5) === true, 'should grant a full bucket');
      assert(b.tryRemove(1) === false, 'empty bucket at t=0 should deny');
    },
  ],
  [
    'default count is 1',
    () => {
      const b = new TokenBucket(2, 1, new FakeClock());
      assert(b.tryRemove() === true, 'first default remove');
      assert(b.tryRemove() === true, 'second default remove');
      assert(b.tryRemove() === false, 'third should deny');
    },
  ],
  [
    'request larger than capacity always denied, consumes nothing',
    () => {
      const b = new TokenBucket(3, 1, new FakeClock());
      assert(b.tryRemove(5) === false, 'over-capacity request denied');
      assert(b.tryRemove(3) === true, 'full bucket still intact after denied over-cap request');
    },
  ],
  /** The rate is 2 tokens per second, so 1 second adds 2 tokens. */
  [
    'proportional refill over time',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 2, c);
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(1000);
      assert(b.tryRemove(2) === true, 'refilled 2 after 1s');
      assert(b.tryRemove(1) === false, 'no more than refilled');
    },
  ],
  /** 10 seconds at 100 tokens per second give 1000 tokens, and the capacity of 5 must cap the balance. */
  [
    'refill caps at capacity',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(5, 100, c);
      assert(b.tryRemove(5) === true, 'drain');
      c.advance(10_000);
      assert(b.tryRemove(5) === true, 'capped refill grants exactly capacity');
      assert(b.tryRemove(1) === false, 'not more than capacity');
    },
  ],
  /** The rate is 2 tokens per second, so 500 ms add exactly 1 token. */
  [
    'fractional refill (sub-token) accrues correctly',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 2, c);
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(500);
      assert(b.tryRemove(1) === true, 'half second refills exactly 1');
      assert(b.tryRemove(1) === false, 'nothing left');
    },
  ],
  /** The rate is 1 token per second, so 2 seconds give a balance of 2. The denied request for 3 must leave both tokens. */
  [
    'failed request consumes nothing (no partial consumption)',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(5, 1, c);
      assert(b.tryRemove(5) === true, 'drain');
      c.advance(2000);
      assert(b.tryRemove(3) === false, 'insufficient, must deny');
      assert(b.tryRemove(2) === true, 'the 2 tokens were NOT consumed by the failed call');
    },
  ],
  [
    'never goes negative / repeated denials on empty bucket',
    () => {
      const b = new TokenBucket(1, 1, new FakeClock());
      assert(b.tryRemove(1) === true, 'take the one token');
      assert(b.tryRemove(1) === false, 'empty');
      assert(b.tryRemove(1) === false, 'still empty (no negative balance)');
    },
  ],
  /** The rate is 1 token per second, so each 500 ms step adds 0.5 token. The denied read must not discard the first 0.5. */
  [
    'refill accrues across multiple reads without losing time',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 1, c);
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(500);
      assert(b.tryRemove(1) === false, 'only 0.5 accrued');
      c.advance(500);
      assert(b.tryRemove(1) === true, 'two half-seconds accrue to a full token');
    },
  ],
];

let passed = 0;
const failures: string[] = [];
for (const [name, fn] of checks) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(JSON.stringify({ passed, failed: failures.length, total: checks.length, failures }));
