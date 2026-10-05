// Acceptance test for the recovery of a merge that stops mid-flight. It uses a
// real SQLite event store, the real `ps`, `inspect` and `wait` handlers, and the
// real liveness registry. The subscription clock and the wait deadline are
// injected, so the test has no sleep.

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../../src/events/store.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import type { SubscriptionClock } from '../../../../../src/events/subscriptions.js';
import { handleViewPs } from '../../../../../src/projections/views/lifecycle/ps.js';
import { handleViewInspect } from '../../../../../src/projections/views/lifecycle/inspect.js';
import { handleViewWait, type WaitDeps } from '../../../../../src/projections/views/lifecycle/wait.js';
import type { InFlightOperation } from '../../../../../src/projections/views/lifecycle/operations-fold.js';

/** Fixed fold-time clock for the `ps` calls. */
const NOW_MS = Date.parse('2026-07-13T00:00:10.000Z');

/**
 * A {@link SubscriptionClock} whose poll-floor loop runs only when a test calls `fireAll()`. It
 * goes in through `WaitDeps.subscriptionOptions`, and the first subscribe on a new store adopts it.
 * This test never fires the floor, because the fired deadline ends the wait.
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

/**
 * A real SQLite `EventStore` with no injected backend. `ctx.storage` is unset on purpose: the
 * operations section of `ps` reads only the event store, and the workflows section stays empty.
 */
async function makeArm(): Promise<Arm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 's6-acceptance-'));
  const store = new EventStore(stateDir);
  await store.initialize();
  const ctx: DispatchContext = { stateDir, eventStore: store, enableTelemetry: false };
  const arm: Arm = { stateDir, store, ctx };
  arms.push(arm);
  return arm;
}

/** Flush the micro/macrotask queue so a not-awaited `wait` reaches its subscribe. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic wait deps: a fixed clock + a captured deadline the test fires. */
function deterministicDeps(clock: SubscriptionClock): {
  deps: WaitDeps;
  fireDeadline: () => void;
} {
  let deadlineCb: (() => void) | undefined;
  const deps: WaitDeps = {
    now: () => 1000,
    scheduleTimeout: (cb) => {
      deadlineCb = cb;
      return () => {
        deadlineCb = undefined;
      };
    },
    subscriptionOptions: { clock },
  };
  return { deps, fireDeadline: () => deadlineCb?.() };
}

async function seedWorkflow(store: EventStore, featureId: string): Promise<void> {
  await store.append(featureId, {
    type: 'workflow.started',
    data: { featureId, workflowType: 'feature' },
  });
}

/** Commit a `merge.executing_started` CLAIM with NO terminal — the crash. */
async function seedCrashedMerge(store: EventStore, featureId: string, instanceId: string): Promise<void> {
  await store.append(featureId, {
    type: 'merge.executing_started',
    data: {
      instanceId,
      sourceBranch: 'feat/s6',
      targetBranch: 'main',
      recoveryPointSha: 'deadbeef',
      startedAt: new Date().toISOString(),
    },
  });
}

/** Appends `merge.recovered`, a registry terminal for `merge`, with the same instance key. */
async function appendMergeRecovered(store: EventStore, featureId: string, instanceId: string): Promise<void> {
  await store.append(featureId, {
    type: 'merge.recovered',
    data: {
      instanceId,
      sourceBranch: 'feat/s6',
      targetBranch: 'main',
      recoveryPointSha: 'deadbeef',
    },
  });
}

describe('S-6 stuck-executing merge recovery (acceptance — real store, real handlers)', () => {
  /**
   * `ps --scope all` lists the merge that has a start and no terminal, and `inspect` shows the
   * start event. `wait --operation merge` returns `WAIT_TIMEOUT` when the test fires the deadline.
   * After `merge.recovered`, a new wait resolves in the precheck, and `ps` does not list the merge.
   */
  it('S6_StuckMerge_PsInspectWaitTimeout_ThenRecoveredWaitResolves', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 's6-feat';
    const instanceId = 'merge-crash-1';

    await seedWorkflow(store, featureId);
    await seedCrashedMerge(store, featureId, instanceId);

    const psResult = await handleViewPs({ scope: 'all' }, ctx, { now: () => NOW_MS });
    expect(psResult.success).toBe(true);
    const psData = psResult.data as {
      scope: string;
      operations: InFlightOperation[];
      operationCount: number;
    };
    expect(psData.scope).toBe('all');
    const stuckMerge = psData.operations.find((o) => o.surface === 'merge');
    expect(stuckMerge).toBeDefined();
    expect(stuckMerge?.instanceKey).toBe(instanceId);
    expect(stuckMerge?.streamScope).toBe('feature');
    expect(stuckMerge?.startType).toBe('merge.executing_started');
    expect(stuckMerge?.ageMs).toBeGreaterThanOrEqual(0);

    const inspectResult = await handleViewInspect({ featureId }, ctx);
    expect(inspectResult.success).toBe(true);
    const inspectData = inspectResult.data as {
      workflowExists: boolean;
      recentEvents: Array<{ type: string }>;
    };
    expect(inspectData.workflowExists).toBe(true);
    const inspectedTypes = inspectData.recentEvents.map((e) => e.type);
    expect(inspectedTypes).toContain('merge.executing_started');
    expect(inspectedTypes).not.toContain('merge.executed');
    expect(inspectedTypes).not.toContain('merge.recovered');

    const { deps, fireDeadline } = deterministicDeps(new ManualSubscriptionClock());
    const timeoutMs = 250;
    const waitP = handleViewWait({ featureId, operation: 'merge', timeoutMs }, ctx, deps);
    await flush();
    fireDeadline();
    const timeoutResult = await waitP;

    expect(timeoutResult.success).toBe(false);
    expect(timeoutResult.error?.code).toBe('WAIT_TIMEOUT');
    expect((timeoutResult.data as { reason: string }).reason).toBe('wait-timeout');
    expect((timeoutResult.data as { operation?: string }).operation).toBe('merge');
    expect((timeoutResult.data as { timeoutMs: number }).timeoutMs).toBe(timeoutMs);

    await appendMergeRecovered(store, featureId, instanceId);

    const resolveResult = await handleViewWait({ featureId, operation: 'merge' }, ctx);
    expect(resolveResult.success).toBe(true);
    expect((resolveResult.data as { resolved: boolean }).resolved).toBe(true);
    expect((resolveResult.data as { waitedMs: number }).waitedMs).toBe(0);
    expect((resolveResult.data as { operation?: string }).operation).toBe('merge');

    const psAfter = await handleViewPs({ scope: 'all' }, ctx, { now: () => NOW_MS });
    const opsAfter = (psAfter.data as { operations: InFlightOperation[] }).operations;
    expect(opsAfter.some((o) => o.surface === 'merge')).toBe(false);
  });

  /**
   * This test is a guard, not the proof. `wait.ts` and `operations-fold.ts` take each surface from
   * the registry, so they must not branch on the `merge` literal. The patterns do not match the
   * `until: 'merge'` payload of the suggested fix, because that payload is not a branch.
   */
  it('S6_Fence_GenericVerbsDoNotBranchOnMergeLiteral', () => {
    const waitSrc = readFileSync(fileURLToPath(new URL('../../../../../src/projections/views/lifecycle/wait.ts', import.meta.url)), 'utf-8');
    const foldSrc = readFileSync(fileURLToPath(new URL('../../../../../src/projections/views/lifecycle/operations-fold.ts', import.meta.url)), 'utf-8');

    const MERGE_BRANCH_PATTERNS: readonly RegExp[] = [
      /===\s*['"]merge['"]/,
      /['"]merge['"]\s*===/,
      /!==\s*['"]merge['"]/,
      /['"]merge['"]\s*!==/,
      /case\s+['"]merge['"]/,
    ];

    for (const file of [
      { name: 'wait.ts', text: waitSrc },
      { name: 'operations-fold.ts', text: foldSrc },
    ]) {
      for (const pattern of MERGE_BRANCH_PATTERNS) {
        expect(
          pattern.test(file.text),
          `${file.name} must not branch on the 'merge' surface literal (matched ${pattern})`,
        ).toBe(false);
      }
    }
  });
});
