// ─── `wait` — generic event-driven gate (DR-5 / DR-8) ────────────────────────
//
// Boundary discipline: every test drives the REAL event store + REAL DR-1
// subscription primitive + REAL DR-2 liveness registry — no hand-mocks of those
// seams. Determinism comes from INJECTED clocks/timers only (INV-16): a
// `ManualClock` on the subscription registry drives the Tier-2 floor tick-by-
// tick, and a captured `scheduleTimeout` fires the bounded deadline directly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../events/store.js';
import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';
import type { SubscriptionClock } from '../../../events/subscriptions.js';
import {
  handleViewWait,
  phasePredicate,
  statusPredicate,
  operationPredicate,
  type WaitDeps,
} from './wait.js';
import { LIVENESS_REGISTRY } from '../../../events/liveness-registry.js';

// ─── Manually-driven subscription clock (INV-16) ──────────────────────────────
//
// Mirrors the `ManualClock` in `subscriptions.test.ts`: a real, deterministic
// SubscriptionClock whose Tier-2 floor loop fires only when the test calls
// `fireAll()` — no wall-clock sleep. Injected via `WaitDeps.subscriptionOptions`
// so the wait's own DR-1 subscription runs on it (the FIRST subscribe on a fresh
// store, so the lazily-created registry adopts this clock).
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

// ─── Arm / fixtures ──────────────────────────────────────────────────────────

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

// ─── Precheck (immediate resolution, no subscription) ────────────────────────

describe('wait — phase predicate', () => {
  it('Wait_PhaseAlreadyPassed_ReturnsImmediatelyWithoutSubscribing', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-passed';
    await seedWorkflow(store, featureId);
    await appendTransition(store, featureId, 'plan', 'plan-review');
    await appendTransition(store, featureId, 'plan-review', 'delegate');

    const before = await totalEvents(store);
    // No injected deadline is fired: if this SUBSCRIBED, it would hang → the
    // test would time out. Immediate precheck resolution is the only way it
    // returns without us firing a deadline.
    const result = await handleViewWait({ featureId, phase: 'plan-review' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect((result.data as { waitedMs: number }).waitedMs).toBe(0);
    expect((result.data as { phase?: string }).phase).toBe('plan-review');
    expect(await totalEvents(store)).toBe(before);
  });

  it('Wait_TimeoutMsAboveNodeTimerCeiling_ClampedNotWrappedToNearImmediate', async () => {
    // Node's setTimeout does NOT clamp: a delay above 2^31-1 ms silently
    // becomes 1ms and fires almost immediately, flipping a deliberately-huge
    // timeoutMs into a near-instant WAIT_TIMEOUT — the exact opposite of the
    // caller's "wait longer" intent. The resolved budget must be clamped.
    const { store, ctx } = await makeArm();
    const featureId = 'feat-clamp';
    await seedWorkflow(store, featureId);

    const { deps, fireDeadline, scheduledMs } = deterministicDeps();
    // Well past the ceiling (~24.85 days).
    const waitP = handleViewWait(
      { featureId, phase: 'plan-review', timeoutMs: 9_999_999_999 },
      ctx,
      deps,
    );
    await flush(); // let the precheck complete and the deadline get scheduled

    expect(scheduledMs()).toBe(2_147_483_647);

    fireDeadline(); // resolve the pending wait so the test doesn't hang
    const result = await waitP;
    expect(result.success).toBe(false);
  });

  it('Wait_InProcessTransition_ResolvesOnTier1Wake', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-tier1';
    await seedWorkflow(store, featureId);

    const clock = new ManualSubscriptionClock();
    const { deps } = deterministicDeps(clock);
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'plan-review', timeoutMs: 60_000 }, ctx, deps);
    await flush(); // let the precheck complete and the subscription register

    // In-process append → Tier-1 post-commit hook delivers synchronously; NO
    // floor tick is fired (clock.fireAll never called).
    await appendTransition(store, featureId, 'plan', 'plan-review');
    const result = await waitP;

    expect(result.success).toBe(true);
    expect((result.data as { phase?: string }).phase).toBe('plan-review');
    const perf = (result.data as { perf?: { floorTicks: number; floorDrains: number } }).perf;
    expect(perf?.floorTicks).toBe(0); // resolved on Tier-1 wake — no floor tick consumed
    expect(perf?.floorDrains).toBe(0);
    // The transition is the ONLY new event; wait appended nothing.
    expect(await totalEvents(store)).toBe(before + 1);
  });

  it('Wait_ForeignConnectionEvent_ResolvesWithinOneFloorTick_PerfSurfaced', async () => {
    const { store, ctx, stateDir } = await makeArm();
    const featureId = 'feat-foreign';
    await seedWorkflow(store, featureId);

    // A second connection on the same DB: its commit does NOT wake `store`'s
    // Tier-1 hook, so only the Tier-2 poll floor can pull it.
    const foreign = new EventStore(stateDir);
    await foreign.initialize();
    try {
      const clock = new ManualSubscriptionClock();
      const { deps } = deterministicDeps(clock);

      const waitP = handleViewWait({ featureId, phase: 'plan-review', timeoutMs: 60_000 }, ctx, deps);
      await flush(); // wait subscribes on `store` with the ManualClock floor

      await appendTransition(foreign, featureId, 'plan', 'plan-review'); // foreign — no Tier-1 wake
      await flush();
      // Exactly one floor tick drains the foreign commit and resolves the wait.
      clock.fireAll();
      const result = await waitP;

      expect(result.success).toBe(true);
      expect((result.data as { phase?: string }).phase).toBe('plan-review');
      const perf = (result.data as { perf?: { floorMs: number; floorDrains: number } }).perf;
      expect(perf).toBeDefined();
      expect(perf?.floorMs).toBeGreaterThan(0); // the floor interval is surfaced
      expect(perf?.floorDrains).toBe(1); // resolved within ONE floor drain
    } finally {
      foreign.close();
    }
  });

  it('Wait_Timeout_StructuredWaitTimeout', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-timeout';
    await seedWorkflow(store, featureId); // stays in 'plan'

    const { deps, fireDeadline } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'delegate', timeoutMs: 5000 }, ctx, deps);
    await flush();
    fireDeadline(); // fire the bounded deadline
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_TIMEOUT');
    expect((result.data as { reason: string }).reason).toBe('wait-timeout');
    expect((result.data as { timeoutMs: number }).timeoutMs).toBe(5000);
    expect(await totalEvents(store)).toBe(before);
  });

  it('Wait_WorkflowCancelledMidWait_WaitFailed', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-cancel';
    await seedWorkflow(store, featureId);

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, phase: 'review', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    // The workflow is cancelled while we wait on `review` → review unreachable.
    await appendTransition(store, featureId, 'plan', 'cancelled');
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_FAILED');
    expect((result.data as { terminalStatus: string }).terminalStatus).toBe('cancelled');
    expect(await totalEvents(store)).toBe(before + 1); // only the transition
  });
});

// ─── Status predicate ─────────────────────────────────────────────────────────

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

  it('Wait_StatusPredicate_DifferentTerminalArrives_WaitFailed', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-diff';
    await seedWorkflow(store, featureId);

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const waitP = handleViewWait({ featureId, status: 'completed', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    // Requested `completed`, but `cancelled` arrives first → WAIT_FAILED.
    await appendTransition(store, featureId, 'plan', 'cancelled');
    const result = await waitP;

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('WAIT_FAILED');
    expect((result.data as { terminalStatus: string }).terminalStatus).toBe('cancelled');
  });

  it('Wait_StatusPredicate_NonTerminalStatus_InvalidInputWithTerminalTargets', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-status-nonterminal';
    await seedWorkflow(store, featureId);
    // Drive the workflow INTO the `delegate` phase. Pre-fix, `--status delegate`
    // built a statusPredicate whose seedPhase already equals `delegate`, so the
    // precheck resolved IMMEDIATELY on phase-equality — conflating status with
    // phase. The guard must reject `delegate` (a non-terminal phase, not a
    // terminal status) with INVALID_INPUT BEFORE that conflation can occur,
    // symmetric with the `--phase` topology guard and the `--operation` surface
    // guard.
    await appendTransition(store, featureId, 'plan', 'delegate');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, status: 'delegate' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // validTargets = exactly the terminal statuses; `delegate` is not among them.
    expect(result.error?.validTargets).toEqual(['completed', 'failed', 'cancelled']);
    expect(result.error?.validTargets).not.toContain('delegate');
    expect(result.error?.expectedShape).toHaveProperty('status');
    // It must NOT have resolved immediately (the pre-fix phase-equality bug).
    expect((result.data as { resolved?: boolean } | undefined)?.resolved).not.toBe(true);
    expect(await totalEvents(store)).toBe(before); // side-effect free
  });
});

// ─── Operation predicate (S-6) ────────────────────────────────────────────────

describe('wait — operation predicate (S-6)', () => {
  it('Wait_OperationPredicate_ResolvesOnRegistryTerminalByInstanceKey', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op';
    await seedWorkflow(store, featureId);
    await appendMergeStart(store, featureId, 'merge-1'); // in flight

    const { deps } = deterministicDeps(new ManualSubscriptionClock());
    const before = await totalEvents(store);

    const waitP = handleViewWait({ featureId, operation: 'merge', timeoutMs: 60_000 }, ctx, deps);
    await flush();
    // The registry terminal for the SAME instance key clears the in-flight set.
    await appendMergeTerminal(store, featureId, 'merge-1');
    const result = await waitP;

    expect(result.success).toBe(true);
    expect((result.data as { operation?: string }).operation).toBe('merge');
    expect(await totalEvents(store)).toBe(before + 1); // only the terminal event
  });

  it('Wait_OperationPredicate_NoInFlight_ReturnsImmediately', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op-idle';
    await seedWorkflow(store, featureId);
    // A merge that already completed → nothing in flight.
    await appendMergeStart(store, featureId, 'merge-done');
    await appendMergeTerminal(store, featureId, 'merge-done');

    const before = await totalEvents(store);
    const result = await handleViewWait({ featureId, operation: 'merge' }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { waitedMs: number }).waitedMs).toBe(0);
    expect(await totalEvents(store)).toBe(before);
  });

  it('Wait_OperationPredicate_NonFeatureScopedSurface_InvalidInputWithSuggestedFix', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 'feat-op-launch';
    await seedWorkflow(store, featureId);

    const before = await totalEvents(store);
    // `launch` is worktrees-scoped (not feature-observable).
    const result = await handleViewWait({ featureId, operation: 'launch' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // validTargets = the feature-scoped surfaces; suggestedFix points at `until`.
    expect(result.error?.validTargets).toEqual(expect.arrayContaining(['merge', 'mutation']));
    expect(result.error?.validTargets).not.toContain('launch');
    // `wait` is an exarchos_view ACTION, not a tool of its own — the fix must
    // name the tool and carry `action`, or a client cannot replay it (INV-5b).
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(result.error?.suggestedFix?.params).toMatchObject({ action: 'wait' });
    expect(result.error?.suggestedFix?.params).toHaveProperty('until');
    expect(await totalEvents(store)).toBe(before); // side-effect free
  });
});

// ─── Worktree scope preservation (WLM-6 kernel absorbed) ─────────────────────

describe('wait — worktree scope (WLM-6 absorbed)', () => {
  it('Wait_WorktreeScope_PreservesWlm6Capabilities', async () => {
    const { store, ctx } = await makeArm();
    const before = await totalEvents(store);

    // `until: 'idle'` on a store with no in-flight prune resolves immediately —
    // the exact WLM-6 kernel behavior, now reached through the generic verb.
    const result = await handleViewWait({ until: 'idle', timeoutMs: 1000 }, ctx);

    expect(result.success).toBe(true);
    expect((result.data as { until?: string; resolved: boolean }).until).toBe('idle');
    expect((result.data as { resolved: boolean }).resolved).toBe(true);
    expect(await totalEvents(store)).toBe(before); // pure read
  });
});

// ─── Event-count invariance across EVERY path (load-bearing) ──────────────────

describe('wait — appends zero events on every path', () => {
  it('Wait_AllPaths_AppendZeroEvents', async () => {
    const { store, ctx } = await makeArm();

    // Seed several workflows in distinct states so each path is reachable.
    await seedWorkflow(store, 'wf-plan'); // stays in plan
    await seedWorkflow(store, 'wf-passed');
    await appendTransition(store, 'wf-passed', 'plan', 'plan-review');
    await seedWorkflow(store, 'wf-done');
    await appendTransition(store, 'wf-done', 'plan', 'completed');
    await seedWorkflow(store, 'wf-op');
    await appendMergeStart(store, 'wf-op', 'm-1');
    await appendMergeTerminal(store, 'wf-op', 'm-1');

    // Every terminal-outcome invocation (some via a fired deadline).
    const invocations: Array<() => Promise<unknown>> = [
      // precheck-resolved (phase already visited)
      () => handleViewWait({ featureId: 'wf-passed', phase: 'plan-review' }, ctx),
      // precheck-resolved (status already terminal)
      () => handleViewWait({ featureId: 'wf-done', status: 'completed' }, ctx),
      // precheck-failed (status different terminal already)
      () => handleViewWait({ featureId: 'wf-done', status: 'cancelled' }, ctx),
      // precheck-resolved (operation none in flight)
      () => handleViewWait({ featureId: 'wf-op', operation: 'merge' }, ctx),
      // no feature predicate → worktree kernel (INVALID_INPUT: missing integrationRef)
      () => handleViewWait({ featureId: 'wf-plan' }, ctx),
      // invalid input (non-feature-scoped operation)
      () => handleViewWait({ featureId: 'wf-plan', operation: 'prune' }, ctx),
      // cold probe (unknown featureId)
      () => handleViewWait({ featureId: 'no-such-feature', phase: 'plan' }, ctx),
      // worktree scope (idle, no prunes)
      () => handleViewWait({ until: 'idle', timeoutMs: 1000 }, ctx),
      // subscription → timeout (deadline fired)
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

// ─── Property test (state-machine): resolves iff the predicate is satisfied ───

describe('wait — predicate state-machine property', () => {
  const PHASES = ['plan', 'plan-review', 'delegate', 'review', 'synthesize', 'completed', 'cancelled'] as const;
  const TERMINALS = new Set(['completed', 'failed', 'cancelled']);

  // Build a random ordered transition-event list from an arbitrary phase walk.
  const transitionsArb = fc.array(
    fc.record({ from: fc.constantFrom(...PHASES), to: fc.constantFrom(...PHASES) }),
    { maxLength: 12 },
  );

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

          // Model: resolved iff target ∈ {seed} ∪ {from,to across the walk}.
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

          // Model the in-flight fold: last write per key wins.
          const inFlight = new Set<string>();
          for (const o of ops) {
            if (o.kind === 'start') inFlight.add(o.key);
            else inFlight.delete(o.key);
          }
          expect(verdict.kind === 'resolved').toBe(inFlight.size === 0);
          expect(verdict.kind).not.toBe('failed'); // operation never fails
        },
      ),
    );
  });
});
