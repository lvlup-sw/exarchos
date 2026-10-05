// Proves that `yield-between-tests.ts`, the setup file every project loads,
// yields to the event loop between tests (#2029).
//
// Without the yield, the runner goes from one test to the next on promise
// continuations alone. A macrotask that one test queues then has not run when
// the next test starts.
import { afterAll, describe, expect, it, vi } from 'vitest';

/** A macrotask queued by one test runs before the next test starts. */
describe('YieldBetweenTests', () => {
  let macrotaskRan = false;

  /** Queues the macrotask that the next test observes. */
  it('QueuesAMacrotask', () => {
    setImmediate(() => {
      macrotaskRan = true;
    });
    expect(macrotaskRan).toBe(false);
  });

  /** Fails when nothing yields between the two tests. */
  it('MacrotaskFromThePreviousTest_HasRunBeforeThisTestStarts', () => {
    expect(macrotaskRan).toBe(true);
  });
});

/** The yield still completes while a test has left fake timers installed. */
describe('YieldBetweenTests_UnderFakeTimers', () => {
  afterAll(() => {
    vi.useRealTimers();
  });

  /** Leaves fake timers on, so the hooks after it run under them. */
  it('LeavesFakeTimersInstalled', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
  });

  /** Reached only if the hooks between the two tests did not stall. */
  it('NextTestStarts_BecauseTheYieldUsesRealTimers', () => {
    expect(vi.isFakeTimers()).toBe(true);
  });
});
