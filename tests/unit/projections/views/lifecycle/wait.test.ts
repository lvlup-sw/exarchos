// Tests for the `wait` lifecycle verb. The handler tests use a real event
// store, the real subscription primitive and the real liveness registry. A
// manual clock drives the poll floor, and a captured `scheduleTimeout` fires the
// deadline, so no test sleeps. The property tests call the predicates directly,
// with no store.

import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../../src/events/store.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import type { SubscriptionClock } from '../../../../../src/events/subscriptions.js';
import {
  handleViewWait,
  phasePredicate,
  statusPredicate,
  operationPredicate,
  type WaitDeps,
} from '../../../../../src/projections/views/lifecycle/wait.js';
import { LIVENESS_REGISTRY } from '../../../../../src/events/liveness-registry.js';

/**
 * A {@link SubscriptionClock} whose poll-floor loop runs only when a test calls `fireAll()`. It
 * goes in through `WaitDeps.subscriptionOptions`. The first subscribe on a new store creates the
 * registry, and the registry adopts this clock.
 */
class ManualSubscriptionClock implements SubscriptionClock {
  time = 0;
  private readonly loops: Array<{ tick: () => void }> = [];
  now(): number {
    return this.time;
  }
  scheduleInterval(tick: () => void): () => void {
    const entry = { tick };
    this.loops.push(entry);
    return () => {
      const i = this.loops.indexOf(entry);
      if (i >= 0) this.loops.splice(i, 1);
    };
  }
  fireAll(): void {
    for (const { tick } of [...this.loops]) tick();
  }
}

interface Arm {
  readonly stateDir: string;
  readonly store: EventStore;
  readonly ctx: DispatchContext;
}

let arms: Arm[] = [];

afterEach(async () => {
  for (const arm of arms) {
    arm.store.close();
    await rmrfAsync(arm.stateDir);
  }
  arms = [];
});

async function makeArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wait-verb-'));
  const store = new EventStore(stateDir);
  await store.initialize();
  const ctx = { stateDir, eventStore: store, enableTelemetry: false } as unknown as DispatchContext;
  const arm: Arm = { stateDir, store, ctx };
  arms.push(arm);
  return arm;
}

/** Flush the microtask + macrotask queue so a not-awaited `wait` reaches its subscribe. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function seedWorkflow(store: EventStore, featureId: string, workflowType = 'feature'): Promise<void> {
  await store.append(featureId, { type: 'workflow.started', data: { featureId, workflowType } });
}

async function appendTransition(
  store: EventStore,
  featureId: string,
  from: string,
  to: string,
): Promise<void> {
  await store.append(featureId, {
    type: 'workflow.transition',
    data: { from, to, trigger: 'test', featureId },
  });
}

async function appendMergeStart(store: EventStore, featureId: string, instanceId: string): Promise<void> {
  await store.append(featureId, {
    type: 'merge.executing_started',
    data: {
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      recoveryPointSha: 'deadbeef',
      startedAt: new Date().toISOString(),
      instanceId,
    },
  });
}

async function appendMergeTerminal(store: EventStore, featureId: string, instanceId: string): Promise<void> {
  await store.append(featureId, {
    type: 'merge.executed',
    data: {
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      mergeSha: 'cafef00d',
      rollbackSha: 'deadbeef',
      instanceId,
    },
  });
}

/** Sum committed events across every stream (event-count-invariance witness). */
async function totalEvents(store: EventStore): Promise<number> {
  let total = 0;
  for (const streamId of store.listStreams()) {
    total += (await store.query(streamId)).length;
  }
  return total;
}

/** Deterministic deps: a fixed clock + a captured deadline the test fires. */
function deterministicDeps(clock?: SubscriptionClock): {
  deps: WaitDeps;
  fireDeadline: () => void;
  deadlineScheduled: () => boolean;
  scheduledMs: () => number | undefined;
} {
  let deadlineCb: (() => void) | undefined;
  let scheduledMs: number | undefined;
  const deps: WaitDeps = {
    now: () => 1000,
    scheduleTimeout: (cb, ms) => {
      deadlineCb = cb;
      scheduledMs = ms;
      return () => {
        deadlineCb = undefined;
      };
    },
    ...(clock ? { subscriptionOptions: { clock } } : {}),
  };
  return {
    deps,
    fireDeadline: () => deadlineCb?.(),
    deadlineScheduled: () => deadlineCb !== undefined,
    scheduledMs: () => scheduledMs,
  };
}

describe('wait — phase predicate', () => {
  /**
   * The test injects no deadline. A wait that subscribes blocks past the test timeout, so only
   * the precheck lets the test pass.
   */
  it('Wait_PhaseAlreadyPassed_ReturnsImmediatelyWithoutSubscribing', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-passed';
    await seedWorkflow(store, featureId);
    await appendTransition(store, featureId, 'plan', 'plan-review');
    await appendTransition(store, featureId, 'plan-review', 'delegate');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, phase: 'plan-review' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect((result.data as { waitedMs: number }).waitedMs).toBe(0);
    expect((result.data as { phase?: string }).phase).toBe('plan-review');
    expect(await totalEvents(store)).toBe(before);
  });

  /**
   * Node `setTimeout` does not clamp a delay above 2^31-1 ms. The delay becomes 1 ms, so a very
   * large `timeoutMs` gives a `WAIT_TIMEOUT` almost at once. The handler must clamp the budget.
   */
  it('Wait_TimeoutMsAboveNodeTimerCeiling_ClampedNotWrappedToNearImmediate', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-clamp';
    await seedWorkflow(store, featureId);

    const { deps, fireDeadline, scheduledMs } = deterministicDeps();
    const waitP = handleViewWait(
      { featureId, phase: 'plan-review', timeoutMs: 9_999_999_999 },
      ctx,
      deps,
    );
    await flush();

    expect(scheduledMs()).toBe(2_147_483_647);

    fireDeadline();
    const result = await waitP;
    expect(result.success).toBe(false);
  });

  /**
   * The post-commit hook delivers an event of this process. The test fires no floor tick, and
   * `perf` shows zero floor ticks and zero floor drains.
   */
  it('Wait_InProcessTransition_ResolvesOnTier1Wake', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-tier1';
    await seedWorkflow(store, featureId);

    const clock = new ManualSubscriptionClock();
    const { deps } = deterministicDeps(clock);
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'plan-review', timeoutMs: 60_000 }, ctx, deps);
    await flush();

    await appendTransition(store, featureId, 'plan', 'plan-review');
    const result = await waitP;

    expect(result.success).toBe(true);
    expect((result.data as { phase?: string }).phase).toBe('plan-review');
    const perf = (result.data as { perf?: { floorTicks: number; floorDrains: number } }).perf;
    expect(perf?.floorTicks).toBe(0);
    expect(perf?.floorDrains).toBe(0);
    expect(await totalEvents(store)).toBe(before + 1);
  });

  /**
   * A second connection commits the transition. Its commit does not wake the post-commit hook of
   * `store`, so only the poll floor can read it. One floor tick resolves the wait.
   */
  it('Wait_ForeignConnectionEvent_ResolvesWithinOneFloorTick_PerfSurfaced', async () => {
    const { store, ctx, stateDir } = await makeArm();
    const featureId = 'feat-foreign';
    await seedWorkflow(store, featureId);

    const foreign = new EventStore(stateDir);
    await foreign.initialize();
    try {
      const clock = new ManualSubscriptionClock();
      const { deps } = deterministicDeps(clock);

      const waitP = handleViewWait({ featureId, phase: 'plan-review', timeoutMs: 60_000 }, ctx, deps);
      await flush();

      await appendTransition(foreign, featureId, 'plan', 'plan-review');
      await flush();
      clock.fireAll();
      const result = await waitP;

      expect(result.success).toBe(true);
      expect((result.data as { phase?: string }).phase).toBe('plan-review');
      const perf = (result.data as { perf?: { floorMs: number; floorDrains: number } }).perf;
      expect(perf).toBeDefined();
      expect(perf?.floorMs).toBeGreaterThan(0);
      expect(perf?.floorDrains).toBe(1);
    } finally {
      foreign.close();
    }
  });

  /** The workflow stays in `plan`, so the wait on `delegate` is pending when the test fires the deadline. */
  it('Wait_Timeout_StructuredWaitTimeout', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-timeout';
    await seedWorkflow(store, featureId);

    const { deps, fireDeadline } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'delegate', timeoutMs: 5000 }, ctx, deps);
    await flush();
    fireDeadline();
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    expect((result.data as { reason: string }).reason).toBe('wait-timeout');
    expect((result.data as { timeoutMs: number }).timeoutMs).toBe(5000);
    expect(await totalEvents(store)).toBe(before);
  });

  /** The workflow moves to `cancelled` during the wait, so `review` becomes unreachable. */
  it('Wait_WorkflowCancelledMidWait_WaitFailed', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-cancel';
    await seedWorkflow(store, featureId);

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'review', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    await appendTransition(store, featureId, 'plan', 'cancelled');
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_FAILED');
    expect((result.data as { terminalStatus: string }).terminalStatus).toBe('cancelled');
    expect(await totalEvents(store)).toBe(before + 1);
  });
});

describe('wait — status predicate', () => {
  it('Wait_StatusPredicate_ResolvesOnRequestedTerminal', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-ok';
    await seedWorkflow(store, featureId);
    await appendTransition(store, featureId, 'plan', 'plan-review');

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const waitP = handleViewWait({ featureId, status: 'completed', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    await appendTransition(store, featureId, 'plan-review', 'completed');
    const result = await waitP;

    expect(result.success).toBe(true);
    expect((result.data as { status?: string }).status).toBe('completed');
  });

  it('Wait_StatusPredicate_AlreadyTerminal_ReturnsImmediately', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-done';
    await seedWorkflow(store, featureId);
    await appendTransition(store, featureId, 'plan', 'completed');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, status: 'completed' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { waitedMs: number }).waitedMs).toBe(0);
    expect(await totalEvents(store)).toBe(before);
  });

  /** The wait requests `completed`, and `cancelled` arrives first. */
  it('Wait_StatusPredicate_DifferentTerminalArrives_WaitFailed', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-diff';
    await seedWorkflow(store, featureId);

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const waitP = handleViewWait({ featureId, status: 'completed', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    await appendTransition(store, featureId, 'plan', 'cancelled');
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_FAILED');
    expect((result.data as { terminalStatus: string }).terminalStatus).toBe('cancelled');
  });

  /**
   * The workflow is in `delegate`. With that seed phase, `statusPredicate` resolves a `delegate`
   * request at once, because it compares only the latest phase. The handler must therefore reject
   * a status that is not terminal before it builds the predicate.
   */
  it('Wait_StatusPredicate_NonTerminalStatus_InvalidInputWithTerminalTargets', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-nonterminal';
    await seedWorkflow(store, featureId);
    await appendTransition(store, featureId, 'plan', 'delegate');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, status: 'delegate' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.validTargets).toEqual(['completed', 'failed', 'cancelled']);
    expect(result.error?.validTargets).not.toContain('delegate');
    expect(result.error?.expectedShape).toHaveProperty('status');
    expect((result.data as { resolved?: boolean } | undefined)?.resolved).not.toBe(true);
    expect(await totalEvents(store)).toBe(before);
  });
});

describe('wait — operation predicate (S-6)', () => {
  /** The terminal has the instance key of the in-flight start, so it clears the in-flight set. */
  it('Wait_OperationPredicate_ResolvesOnRegistryTerminalByInstanceKey', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op';
    await seedWorkflow(store, featureId);
    await appendMergeStart(store, featureId, 'merge-1');

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, operation: 'merge', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    await appendMergeTerminal(store, featureId, 'merge-1');
    const result = await waitP;

    expect(result.success).toBe(true);
    expect((result.data as { operation?: string }).operation).toBe('merge');
    expect(await totalEvents(store)).toBe(before + 1);
  });

  /** The merge has its terminal before the call, so no instance is in flight. */
  it('Wait_OperationPredicate_NoInFlight_ReturnsImmediately', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op-idle';
    await seedWorkflow(store, featureId);
    await appendMergeStart(store, featureId, 'merge-done');
    await appendMergeTerminal(store, featureId, 'merge-done');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, operation: 'merge' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { waitedMs: number }).waitedMs).toBe(0);
    expect(await totalEvents(store)).toBe(before);
  });

  /**
   * `launch` is a `worktrees`-scope surface. `wait` is an action of `exarchos_view`, so the
   * suggested fix must name that tool and hold `action`. Without them, a client cannot replay it.
   */
  it('Wait_OperationPredicate_NonFeatureScopedSurface_InvalidInputWithSuggestedFix', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op-launch';
    await seedWorkflow(store, featureId);

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, operation: 'launch' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.validTargets).toEqual(expect.arrayContaining(['merge', 'mutation']));
    expect(result.error?.validTargets).not.toContain('launch');
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(result.error?.suggestedFix?.params).toMatchObject({ action: 'wait' });
    expect(result.error?.suggestedFix?.params).toHaveProperty('until');
    expect(await totalEvents(store)).toBe(before);
  });
});

describe('wait — worktree scope (WLM-6 absorbed)', () => {
  /** `until: 'idle'` goes to the worktree kernel. A store with no in-flight prune resolves at once. */
  it('Wait_WorktreeScope_PreservesWlm6Capabilities', async () => {
    const { store, ctx } = await makeArm();
    const before = await totalEvents(store);

    const result = await handleViewWait({ until: 'idle', timeoutMs: 1000 }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { until?: string; resolved: boolean }).until).toBe('idle');
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(await totalEvents(store)).toBe(before);
  });
});

describe('wait — appends zero events on every path', () => {
  /**
   * Four calls settle in the precheck: one resolves on each axis, and one fails on `status`. Three
   * calls return `INVALID_INPUT`. One call takes the worktree `idle` path, and one ends at a fired
   * deadline. `{ featureId }` alone has no predicate, so it goes to the worktree kernel, which
   * requires `integrationRef`.
   */
  it('Wait_AllPaths_AppendZeroEvents', async () => {
    const { store, ctx } = await makeArm();

    await seedWorkflow(store, 'wf-plan');
    await seedWorkflow(store, 'wf-passed');
    await appendTransition(store, 'wf-passed', 'plan', 'plan-review');
    await seedWorkflow(store, 'wf-done');
    await appendTransition(store, 'wf-done', 'plan', 'completed');
    await seedWorkflow(store, 'wf-op');
    await appendMergeStart(store, 'wf-op', 'm-1');
    await appendMergeTerminal(store, 'wf-op', 'm-1');

    const invocations: Array<() => Promise<unknown>> = [
      () => handleViewWait({ featureId: 'wf-passed', phase: 'plan-review' }, ctx),
      () => handleViewWait({ featureId: 'wf-done', status: 'completed' }, ctx),
      () => handleViewWait({ featureId: 'wf-done', status: 'cancelled' }, ctx),
      () => handleViewWait({ featureId: 'wf-op', operation: 'merge' }, ctx),
      () => handleViewWait({ featureId: 'wf-plan' }, ctx),
      () => handleViewWait({ featureId: 'wf-plan', operation: 'prune' }, ctx),
      () => handleViewWait({ featureId: 'no-such-feature', phase: 'plan' }, ctx),
      () => handleViewWait({ until: 'idle', timeoutMs: 1000 }, ctx),
      async () => {
        const { deps, fireDeadline } = deterministicDeps(new ManualSubscriptionClock());
        const p = handleViewWait({ featureId: 'wf-plan', phase: 'delegate', timeoutMs: 5000 }, ctx, deps);
        await flush();
        fireDeadline();
        return p;
      },
    ];

    for (const run of invocations) {
      const before = await totalEvents(store);
      await run();
      expect(await totalEvents(store)).toBe(before);
    }
  });
});

describe('wait — predicate state-machine property', () => {
  const PHASES = ['plan', 'plan-review', 'delegate', 'review', 'synthesize', 'completed', 'cancelled'] as const;
  const TERMINALS = new Set(['completed', 'failed', 'cancelled']);

  const transitionsArb = fc.array(
    fc.record({ from: fc.constantFrom(...PHASES), to: fc.constantFrom(...PHASES) }),
    { maxLength: 12 },
  );

  /**
   * The model resolves when the target is the seed phase or a `from` or `to` of the walk. It fails
   * when the target is not visited and the latest phase is a terminal status.
   */
  it('PhasePredicate_ResolvesIffTargetVisited_ElseFailedIffTerminal', () => {
    fc.assert(
      fc.property(
        transitionsArb,
        fc.constantFrom(...PHASES),
        fc.constantFrom(...PHASES),
        (walk, seed, target) => {
          const events = walk.map((t) => ({
            streamId: 'f',
            sequence: 0,
            type: 'workflow.transition',
            timestamp: '',
            data: t,
          })) as unknown as Parameters<ReturnType<typeof phasePredicate>['evaluate']>[0];

          const verdict = phasePredicate('f', target, seed).evaluate(events);

          const visited = new Set<string>([seed]);
          let latest = seed;
          for (const t of walk) {
            visited.add(t.from);
            visited.add(t.to);
            latest = t.to;
          }
          const modelResolved = visited.has(target);
          const modelFailed = !modelResolved && TERMINALS.has(latest) && latest !== target;

          expect(verdict.kind === 'resolved').toBe(modelResolved);
          expect(verdict.kind === 'failed').toBe(modelFailed);
          expect(verdict.kind === 'pending').toBe(!modelResolved && !modelFailed);
        },
      ),
    );
  });

  it('StatusPredicate_ResolvesIffLatestIsRequested_FailsIffDifferentTerminal', () => {
    fc.assert(
      fc.property(
        transitionsArb,
        fc.constantFrom('completed', 'failed', 'cancelled'),
        (walk, requested) => {
          const events = walk.map((t) => ({
            streamId: 'f',
            sequence: 0,
            type: 'workflow.transition',
            timestamp: '',
            data: t,
          })) as unknown as Parameters<ReturnType<typeof statusPredicate>['evaluate']>[0];

          const verdict = statusPredicate('f', requested, 'plan').evaluate(events);

          let latest = 'plan';
          for (const t of walk) latest = t.to;
          const modelResolved = latest === requested;
          const modelFailed = !modelResolved && TERMINALS.has(latest);

          expect(verdict.kind === 'resolved').toBe(modelResolved);
          expect(verdict.kind === 'failed').toBe(modelFailed);
        },
      ),
    );
  });

  /** The model is a set of keys: a start adds a key, and a terminal removes it. The verdict is never `failed`. */
  it('OperationPredicate_ResolvesIffNoUnpairedStart', () => {
    const descriptor = LIVENESS_REGISTRY.merge;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('start', 'terminal'),
            key: fc.constantFrom('a', 'b', 'c'),
          }),
          { maxLength: 12 },
        ),
        (ops) => {
          const events = ops.map((o) => ({
            streamId: 'f',
            sequence: 0,
            type: o.kind === 'start' ? descriptor.startType : descriptor.terminalTypes[0],
            timestamp: '',
            data: { instanceId: o.key },
          })) as unknown as Parameters<ReturnType<typeof operationPredicate>['evaluate']>[0];

          const verdict = operationPredicate('f', descriptor).evaluate(events);

          const inFlight = new Set<string>();
          for (const o of ops) {
            if (o.kind === 'start') inFlight.add(o.key);
            else inFlight.delete(o.key);
          }
          expect(verdict.kind === 'resolved').toBe(inFlight.size === 0);
          expect(verdict.kind).not.toBe('failed');
        },
      ),
    );
  });
});
