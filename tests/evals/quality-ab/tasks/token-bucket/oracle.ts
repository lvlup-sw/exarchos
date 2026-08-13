// HIDDEN ORACLE — the agent never sees this. Grades impl.ts against the spec's
// edge cases. Run: `tsx oracle.ts` in a dir containing the produced `impl.ts`.
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
  [
    'proportional refill over time',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 2, c); // 2 tokens/sec
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(1000); // +2 tokens
      assert(b.tryRemove(2) === true, 'refilled 2 after 1s');
      assert(b.tryRemove(1) === false, 'no more than refilled');
    },
  ],
  [
    'refill caps at capacity',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(5, 100, c);
      assert(b.tryRemove(5) === true, 'drain');
      c.advance(10_000); // would be +1000, must cap at 5
      assert(b.tryRemove(5) === true, 'capped refill grants exactly capacity');
      assert(b.tryRemove(1) === false, 'not more than capacity');
    },
  ],
  [
    'fractional refill (sub-token) accrues correctly',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 2, c); // 2/sec => 1 token per 500ms
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(500); // +1 token
      assert(b.tryRemove(1) === true, 'half second refills exactly 1');
      assert(b.tryRemove(1) === false, 'nothing left');
    },
  ],
  [
    'failed request consumes nothing (no partial consumption)',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(5, 1, c); // 1/sec
      assert(b.tryRemove(5) === true, 'drain');
      c.advance(2000); // +2 tokens => balance 2
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
  [
    'refill accrues across multiple reads without losing time',
    () => {
      const c = new FakeClock();
      const b = new TokenBucket(10, 1, c); // 1/sec
      assert(b.tryRemove(10) === true, 'drain');
      c.advance(500); // +0.5
      assert(b.tryRemove(1) === false, 'only 0.5 accrued');
      c.advance(500); // +0.5 => total 1.0 (must not have dropped the first 0.5)
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
