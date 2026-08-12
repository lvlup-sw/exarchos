// ─── Verb error-envelope edge cases across the surface (DR-8) ─────────────────
//
// A consolidated adversarial suite for the STRUCTURED-ERROR contract shared by
// the worktree-lifecycle verbs (`wait` / `inspect` / `export` / `ps`). Boundary
// discipline mirrors `wait.test.ts`: every test drives the REAL event store, the
// REAL HSM topology (`getHSMDefinition`) and the REAL DR-2 liveness registry
// (`featureScopedSurfaces`) — no hand-mocks of those seams. Determinism on the
// one path that would otherwise subscribe comes from an INJECTED, immediately-
// firing deadline (INV-16), so a regression that DROPS the fast-fail validation
// surfaces as a `WAIT_TIMEOUT` rather than a hang.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../events/store.js';
import type { DispatchContext } from '../../../core/dispatch.js';
import type { SubscriptionClock } from '../../../events/subscriptions.js';
import { rmrfAsync } from '../../../test-helpers/temp-dir.js';
import { getHSMDefinition } from '../../../workflow/state-machine.js';
import { handleViewWait, featureScopedSurfaces, type WaitDeps } from './wait.js';
import { handleViewInspect } from './inspect.js';
import { handleViewExport } from './export.js';
import { handleViewPs } from './ps.js';

// ─── Manually-driven subscription clock (INV-16) ──────────────────────────────
//
// A deterministic SubscriptionClock whose Tier-2 floor loop never fires on its
// own (the tests here never subscribe on the happy path). Injected only so a
// KILL-PROBE run — one that reverts the phase-topology validation and falls
// through to subscribe — spins NO real timer.
class ManualSubscriptionClock implements SubscriptionClock {
  time = 0;
  now(): number {
    return this.time;
  }
  scheduleInterval(): () => void {
    return () => {};
  }
}

/**
 * Deps whose bounded deadline fires SYNCHRONOUSLY. With the phase validation in
 * place, `wait` returns `INVALID_INPUT` BEFORE it would ever subscribe, so this
 * deadline is never armed. With the validation reverted (kill-probe), `wait`
 * subscribes and this deadline fires at once → a deterministic `WAIT_TIMEOUT`
 * (not a hang), so the `INVALID_INPUT` assertion goes red fast.
 */
function immediateTimeoutDeps(): WaitDeps {
  return {
    now: () => 1000,
    scheduleTimeout: (cb) => {
      cb();
      return () => {};
    },
    subscriptionOptions: { clock: new ManualSubscriptionClock() },
  };
}

// ─── Arm / fixtures (mirrors wait.test.ts) ────────────────────────────────────

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
  const stateDir = await mkdtemp(path.join(tmpdir(), 'verb-errors-'));
  const store = new EventStore(stateDir);
  await store.initialize();
  const ctx = { stateDir, eventStore: store, enableTelemetry: false } as unknown as DispatchContext;
  const arm: Arm = { stateDir, store, ctx };
  arms.push(arm);
  return arm;
}

async function seedWorkflow(store: EventStore, featureId: string, workflowType = 'feature'): Promise<void> {
  await store.append(featureId, { type: 'workflow.started', data: { featureId, workflowType } });
}

/** Sum committed events across every stream (event-count-invariance witness). */
async function totalEvents(store: EventStore): Promise<number> {
  let total = 0;
  for (const streamId of store.listStreams()) {
    total += (await store.query(streamId)).length;
  }
  return total;
}

/**
 * The WAITABLE phases of a workflow type, derived INDEPENDENTLY from the REAL
 * HSM registry (atomic + final states; compound containers excluded). The
 * handler must produce exactly this set for a type — if it hardcoded a list,
 * this registry-derived expectation would drift on any topology edit.
 */
function waitablePhases(workflowType: string): string[] {
  return Object.values(getHSMDefinition(workflowType).states)
    .filter((state) => state.type !== 'compound')
    .map((state) => state.id)
    .sort();
}

// ─── wait — invalid phase → topology-derived validTargets ─────────────────────

describe('verb error envelopes (DR-8)', () => {
  it('Wait_InvalidPhase_ValidTargetsFromTopologyForWorkflowType', async () => {
    const { store, ctx } = await makeArm();

    // ── feature workflow: `--phase explore` is a refactor-only phase ──────────
    await seedWorkflow(store, 'feat-a', 'feature');
    const beforeFeature = await totalEvents(store);
    const featureResult = await handleViewWait(
      { featureId: 'feat-a', phase: 'explore' },
      ctx,
      immediateTimeoutDeps(),
    );

    expect(featureResult.success).toBe(false);
    expect(featureResult.error?.code).toBe('INVALID_INPUT');
    const featureTargets = featureResult.error?.validTargets;
    // Derived from the REAL feature HSM topology — not a hardcoded list.
    expect(featureTargets).toEqual(waitablePhases('feature'));
    expect(featureTargets).toEqual(expect.arrayContaining(['plan', 'delegate', 'review', 'synthesize']));
    // Compound containers are NOT waitable phases (a workflow is never IN one).
    expect(featureTargets).not.toContain('implementation');
    // A refactor-only phase is not a feature target.
    expect(featureTargets).not.toContain('explore');
    expect(featureTargets).not.toContain('brief');
    // Side-effect-free: the invalid-phase envelope appends nothing.
    expect(await totalEvents(store)).toBe(beforeFeature);

    // ── refactor workflow: `--phase delegate` is a feature-only phase ─────────
    await seedWorkflow(store, 'feat-b', 'refactor');
    const beforeRefactor = await totalEvents(store);
    const refactorResult = await handleViewWait(
      { featureId: 'feat-b', phase: 'delegate' },
      ctx,
      immediateTimeoutDeps(),
    );

    expect(refactorResult.success).toBe(false);
    expect(refactorResult.error?.code).toBe('INVALID_INPUT');
    const refactorTargets = refactorResult.error?.validTargets;
    expect(refactorTargets).toEqual(waitablePhases('refactor'));
    expect(refactorTargets).toEqual(expect.arrayContaining(['explore', 'brief']));
    expect(refactorTargets).not.toContain('delegate');
    // The two type topologies are DISTINCT — validTargets are per-workflow-type.
    expect(refactorTargets).not.toEqual(featureTargets);
    expect(await totalEvents(store)).toBe(beforeRefactor);
  });

  // ─── wait — unknown --operation surface → feature-scoped registry surfaces ───

  it('Wait_UnknownOperationSurface_ValidTargetsListsFeatureScopedSurfaces', async () => {
    const { store, ctx } = await makeArm();
    await seedWorkflow(store, 'feat-op', 'feature');
    const before = await totalEvents(store);

    // `frobnicate` is not a registered DR-2 liveness surface at all.
    const result = await handleViewWait({ featureId: 'feat-op', operation: 'frobnicate' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // validTargets = the feature-scoped surfaces straight off the REAL registry.
    expect(result.error?.validTargets).toEqual(featureScopedSurfaces());
    expect(result.error?.validTargets).toEqual(expect.arrayContaining(['merge', 'mutation']));
    // The worktrees-scoped surfaces are NOT feature-observable → excluded.
    expect(result.error?.validTargets).not.toContain('launch');
    expect(result.error?.validTargets).not.toContain('prune');
    // suggestedFix steers the caller to the worktree `until` scope — as a
    // REAL action-call: `wait` is an exarchos_view action, not a tool of its
    // own, so the shape must name the tool and carry `action` in params or a
    // client cannot replay it verbatim (INV-5b).
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(result.error?.suggestedFix?.params).toMatchObject({ action: 'wait' });
    expect(result.error?.suggestedFix?.params).toHaveProperty('until');
    // Side-effect-free.
    expect(await totalEvents(store)).toBe(before);
  });

  // ─── inspect / wait / export on an unknown featureId → side-effect-free ──────

  it('Verbs_UnknownFeatureId_SideEffectFreeExpectedShape', async () => {
    const { store, ctx } = await makeArm();
    // An UNRELATED workflow so the invariance witness is a non-zero baseline: a
    // cold probe of a different id must not mutate it (no phantom stream).
    await seedWorkflow(store, 'feat-real', 'feature');
    const unknown = 'no-such-feature';

    // ── inspect: expected shape is a `workflowExists: false` success ──────────
    let before = await totalEvents(store);
    const inspectResult = await handleViewInspect({ featureId: unknown }, ctx);
    expect(inspectResult.success).toBe(true);
    expect((inspectResult.data as { workflowExists?: boolean }).workflowExists).toBe(false);
    expect((inspectResult.data as { eventCount?: number }).eventCount).toBe(0);
    expect(inspectResult._meta?.workflowExists).toBe(false);
    expect(await totalEvents(store)).toBe(before); // event-count invariance

    // ── wait: expected shape is a structured INVALID_INPUT cold-probe ─────────
    before = await totalEvents(store);
    const waitResult = await handleViewWait({ featureId: unknown, phase: 'plan' }, ctx);
    expect(waitResult.success).toBe(false);
    expect(waitResult.error?.code).toBe('INVALID_INPUT');
    expect(waitResult.error?.expectedShape).toBeDefined();
    expect(await totalEvents(store)).toBe(before); // event-count invariance

    // ── export: expected shape is a `workflowExists: false` / not-exported ─────
    before = await totalEvents(store);
    const exportResult = await handleViewExport({ featureId: unknown }, ctx);
    expect(exportResult.success).toBe(true);
    expect((exportResult.data as { workflowExists?: boolean }).workflowExists).toBe(false);
    expect((exportResult.data as { exported?: boolean }).exported).toBe(false);
    expect(exportResult._meta?.workflowExists).toBe(false);
    expect(await totalEvents(store)).toBe(before); // event-count invariance
  });

  // ─── ps — probe outside the worktree scope → INVALID_INPUT + suggestedFix ────

  it('Ps_ProbeOutsideWorktreeScope_InvalidInputWithSuggestedFix', async () => {
    const { store, ctx } = await makeArm();
    const before = await totalEvents(store);

    // `probe` is a worktree-scope-only capability — the workflows/operations
    // folds are pure reads with no process probe.
    const workflowScoped = await handleViewPs({ scope: 'workflow', probe: true }, ctx);
    expect(workflowScoped.success).toBe(false);
    expect(workflowScoped.error?.code).toBe('INVALID_INPUT');
    expect(workflowScoped.error?.validTargets).toContain('worktree');
    expect(workflowScoped.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(workflowScoped.error?.suggestedFix?.params).toMatchObject({ scope: 'worktree', probe: true });

    // The DEFAULT scope ('all') is likewise not probe-able.
    const defaultScoped = await handleViewPs({ probe: true }, ctx);
    expect(defaultScoped.success).toBe(false);
    expect(defaultScoped.error?.code).toBe('INVALID_INPUT');
    expect(defaultScoped.error?.suggestedFix?.params).toMatchObject({ scope: 'worktree' });

    // Pure read: rejecting probe appends nothing.
    expect(await totalEvents(store)).toBe(before);
  });
});
