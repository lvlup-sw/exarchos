// ─── S-6 north-star: stuck-executing merge recovery acceptance (DR-3/DR-5/DR-8) ─
//
// The feature's ACCEPTANCE walkthrough. ONE test drives the REAL SQLite event
// store + the REAL lifecycle handlers (`ps`, `inspect`, `wait`) + the REAL DR-2
// liveness registry — NO mocks of the store, the folds, or the registry — end
// to end through the corrected S-6 story:
//
//   1. A merge crashes mid-flight: a `merge.executing_started` with NO terminal
//      is committed to a real store (the simulated crash).
//   2. `ps --scope all` lists the stuck merge in its OPERATIONS section
//      (`{surface:'merge', instanceKey:…}`) — the DR-3 north-star assertion.
//   3. `inspect` projects the workflow with the unpaired start still in flight
//      (the `merge.executing_started` is in `recentEvents`; no merge terminal).
//   4. `wait --operation merge` with a short timeout returns a STRUCTURED
//      `WAIT_TIMEOUT` (DR-5/DR-8 — the CLI would map this to exit 17) while no
//      terminal exists to clear the in-flight instance.
//   5. Appending `merge.recovered` (a registry terminal for merge, matched by
//      INSTANCE KEY) clears the in-flight set; a fresh `wait --operation merge`
//      now RESOLVES immediately, and `ps` no longer lists the merge.
//
// Determinism comes from INJECTED clocks/timers only (INV-16): a `ManualClock`
// on the subscription registry and a captured `scheduleTimeout` that fires the
// bounded deadline directly — never a wall-clock sleep. The behavioral steps
// ARE the adequacy: a broken `ps` / `inspect` / `wait` would fail this test.
//
// The final `it` is a FENCE, not the proof: a grep guard that neither generic
// verb (`wait.ts` / `operations-fold.ts`) branches on the `merge` surface
// literal — the DR-3 genericity that lets the behavioral steps above hold for
// every liveness surface, not just merge.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../events/store.js';
import type { DispatchContext } from '../../../core/dispatch.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';
import type { SubscriptionClock } from '../../../events/subscriptions.js';
import { handleViewPs } from './ps.js';
import { handleViewInspect } from './inspect.js';
import { handleViewWait, type WaitDeps } from './wait.js';
import type { InFlightOperation } from './operations-fold.js';

// ─── Deterministic clock (INV-16) ─────────────────────────────────────────────

/** Fixed fold-time clock → deterministic `ageMs` on the `ps` operations section. */
const NOW_MS = Date.parse('2026-07-13T00:00:10.000Z');

/**
 * A real, deterministic {@link SubscriptionClock} whose Tier-2 floor loop fires
 * only when the test calls `fireAll()` — mirrors `wait.test.ts`. Injected via
 * `WaitDeps.subscriptionOptions` so the wait's own DR-1 subscription runs on it
 * (the FIRST subscribe on the fresh store adopts this clock). This walkthrough
 * never fires the floor: step 4 resolves via the fired deadline, so no foreign
 * event ever needs draining.
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

// ─── Real-store arm ────────────────────────────────────────────────────────────

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
 * A plain, REAL SQLite `EventStore` (no injected backend) — the same wiring
 * `wait.test.ts` uses, so the DR-1 subscription primitive, the Tier-1 commit
 * hook, and the cross-stream `ps` reads all run against real substrate. The
 * operations section of `ps --scope all` reads purely from the event store, so
 * `ctx.storage` is deliberately unset (the workflows section degrades to empty;
 * the S-6 north-star is the OPERATIONS section).
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

// ─── Seed helpers (via the REAL store's append path) ───────────────────────────

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

/** Append the DR-2 registry terminal `merge.recovered`, matched by instance key. */
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

// ─── The acceptance walkthrough ───────────────────────────────────────────────

describe('S-6 stuck-executing merge recovery (acceptance — real store, real handlers)', () => {
  it('S6_StuckMerge_PsInspectWaitTimeout_ThenRecoveredWaitResolves', async () => {
    const { store, ctx } = await makeArm();
    const featureId = 's6-feat';
    const instanceId = 'merge-crash-1';

    // ── Step 1: seed the crash — a merge start with no terminal on a real store.
    await seedWorkflow(store, featureId);
    await seedCrashedMerge(store, featureId, instanceId);

    // ── Step 2 (DR-3 north-star): `ps --scope all` lists the stuck merge in its
    //    OPERATIONS section, shaped {surface:'merge', instanceKey:…}. ───────────
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
    // Deterministic age off the injected clock (started at T+…, now T+10) → > 0.
    expect(stuckMerge?.ageMs).toBeGreaterThanOrEqual(0);

    // ── Step 3: `inspect` shows the unpaired start still in flight — the
    //    `merge.executing_started` is in `recentEvents`, with NO merge terminal. ─
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

    // ── Step 4 (DR-5/DR-8): `wait --operation merge` with a short timeout returns
    //    a STRUCTURED WAIT_TIMEOUT (CLI → exit 17) while no terminal exists. ─────
    const { deps, fireDeadline } = deterministicDeps(new ManualSubscriptionClock());
    const timeoutMs = 250;
    const waitP = handleViewWait({ featureId, operation: 'merge', timeoutMs }, ctx, deps);
    await flush(); // let the precheck fold + subscription register + deadline capture
    fireDeadline(); // fire the bounded deadline directly (no wall-clock sleep)
    const timeoutResult = await waitP;

    expect(timeoutResult.success).toBe(false);
    expect(timeoutResult.error?.code).toBe('WAIT_TIMEOUT');
    expect((timeoutResult.data as { reason: string }).reason).toBe('wait-timeout');
    expect((timeoutResult.data as { operation?: string }).operation).toBe('merge');
    expect((timeoutResult.data as { timeoutMs: number }).timeoutMs).toBe(timeoutMs);

    // ── Step 5: append `merge.recovered` (registry terminal, matched by instance
    //    key) → a FRESH `wait --operation merge` now resolves immediately. ───────
    await appendMergeRecovered(store, featureId, instanceId);

    const resolveResult = await handleViewWait({ featureId, operation: 'merge' }, ctx);
    expect(resolveResult.success).toBe(true);
    expect((resolveResult.data as { resolved: boolean }).resolved).toBe(true);
    expect((resolveResult.data as { waitedMs: number }).waitedMs).toBe(0); // precheck — never subscribed
    expect((resolveResult.data as { operation?: string }).operation).toBe('merge');

    // And `ps` corroborates: the merge is no longer in flight (recovery cleared it).
    const psAfter = await handleViewPs({ scope: 'all' }, ctx, { now: () => NOW_MS });
    const opsAfter = (psAfter.data as { operations: InFlightOperation[] }).operations;
    expect(opsAfter.some((o) => o.surface === 'merge')).toBe(false);
  });

  // ── Step 6 — FENCE (a guard, not the proof): the DR-3 genericity that makes the
  //    behavioral walkthrough above hold for every liveness surface is that the
  //    generic verbs never BRANCH on the `merge` surface literal. The registry is
  //    the only place a surface is named; the operation predicate + operations
  //    fold iterate it. This grep fails loudly if a future edit re-introduces
  //    merge-specific control flow (`surface === 'merge'` / `case 'merge'`). ─────
  it('S6_Fence_GenericVerbsDoNotBranchOnMergeLiteral', () => {
    const waitSrc = readFileSync(fileURLToPath(new URL('./wait.ts', import.meta.url)), 'utf-8');
    const foldSrc = readFileSync(fileURLToPath(new URL('./operations-fold.ts', import.meta.url)), 'utf-8');

    // Merge-specific BRANCHING patterns (comments and the worktree-scope
    // `until: 'merge'` suggestedFix payload are NOT branching and do not match).
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
