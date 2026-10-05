// Tests for the structured error envelope of the worktree-lifecycle verbs: `wait`, `inspect`, `export` and `ps`.
// Each test uses the real event store, the real HSM topology and the real liveness registry, with no mock of those seams.
// The `wait` phase test injects a deadline that fires at once.
// If the fast-fail validation goes away, that test gets `WAIT_TIMEOUT` and does not hang.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../../src/events/store.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import type { SubscriptionClock } from '../../../../../src/events/subscriptions.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';
import { getHSMDefinition } from '../../../../../src/workflow/state-machine.js';
import { handleViewWait, featureScopedSurfaces, type WaitDeps } from '../../../../../src/projections/views/lifecycle/wait.js';
import { handleViewInspect } from '../../../../../src/projections/views/lifecycle/inspect.js';
import { handleViewExport } from '../../../../../src/projections/views/lifecycle/export.js';
import { handleViewPs } from '../../../../../src/projections/views/lifecycle/ps.js';

/**
 * A `SubscriptionClock` whose interval never fires.
 * A passing test never subscribes. If a broken validation lets `wait` subscribe, this clock starts no real timer.
 */
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
 * Deps whose deadline fires synchronously.
 * With the phase validation in place, `wait` returns `INVALID_INPUT` before it subscribes, so nothing arms the deadline.
 * Without the validation, `wait` subscribes and the deadline fires at once, which gives `WAIT_TIMEOUT` and not a hang.
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
 * The waitable phases of a workflow type, read from the real HSM registry: each state that is not compound.
 * The handler must return this set. A hardcoded list in the handler fails this check after a topology edit.
 */
function waitablePhases(workflowType: string): string[] {
  return Object.values(getHSMDefinition(workflowType).states)
    .filter((state) => state.type !== 'compound')
    .map((state) => state.id)
    .sort();
}

describe('verb error envelopes (DR-8)', () => {
  /**
   * `explore` is a refactor-only phase and `delegate` is a feature-only phase, so each is invalid for the other type.
   * `validTargets` comes from the HSM of the workflow type and holds no compound state.
   * The rejection appends no event.
   */
  it('Wait_InvalidPhase_ValidTargetsFromTopologyForWorkflowType', async () => {
    const { store, ctx } = await makeArm();

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
    expect(featureTargets).toEqual(waitablePhases('feature'));
    expect(featureTargets).toEqual(expect.arrayContaining(['plan', 'delegate', 'review', 'synthesize']));
    expect(featureTargets).not.toContain('implementation');
    expect(featureTargets).not.toContain('explore');
    expect(featureTargets).not.toContain('brief');
    expect(await totalEvents(store)).toBe(beforeFeature);

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
    expect(refactorTargets).not.toEqual(featureTargets);
    expect(await totalEvents(store)).toBe(beforeRefactor);
  });

  /**
   * `frobnicate` is not a registered liveness surface.
   * `validTargets` lists the feature-scoped surfaces only, so it omits `launch` and `prune`.
   * `suggestedFix` must name the `exarchos_view` tool and carry `action: 'wait'`, because `wait` is an action, not a tool.
   * A client can then replay the call as it is. The rejection appends no event.
   */
  it('Wait_UnknownOperationSurface_ValidTargetsListsFeatureScopedSurfaces', async () => {
    const { store, ctx } = await makeArm();
    await seedWorkflow(store, 'feat-op', 'feature');
    const before = await totalEvents(store);

    const result = await handleViewWait({ featureId: 'feat-op', operation: 'frobnicate' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.validTargets).toEqual(featureScopedSurfaces());
    expect(result.error?.validTargets).toEqual(expect.arrayContaining(['merge', 'mutation']));
    expect(result.error?.validTargets).not.toContain('launch');
    expect(result.error?.validTargets).not.toContain('prune');
    expect(result.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(result.error?.suggestedFix?.params).toMatchObject({ action: 'wait' });
    expect(result.error?.suggestedFix?.params).toHaveProperty('until');
    expect(await totalEvents(store)).toBe(before);
  });

  /**
   * A cold probe of an unknown featureId appends no event.
   * An unrelated workflow gives the event count a baseline that is not zero.
   * `inspect` and `export` succeed with `workflowExists: false`. `wait` returns `INVALID_INPUT` with an `expectedShape`.
   */
  it('Verbs_UnknownFeatureId_SideEffectFreeExpectedShape', async () => {
    const { store, ctx } = await makeArm();
    await seedWorkflow(store, 'feat-real', 'feature');
    const unknown = 'no-such-feature';

    let before = await totalEvents(store);
    const inspectResult = await handleViewInspect({ featureId: unknown }, ctx);
    expect(inspectResult.success).toBe(true);
    expect((inspectResult.data as { workflowExists?: boolean }).workflowExists).toBe(false);
    expect((inspectResult.data as { eventCount?: number }).eventCount).toBe(0);
    expect(inspectResult._meta?.workflowExists).toBe(false);
    expect(await totalEvents(store)).toBe(before);

    before = await totalEvents(store);
    const waitResult = await handleViewWait({ featureId: unknown, phase: 'plan' }, ctx);
    expect(waitResult.success).toBe(false);
    expect(waitResult.error?.code).toBe('INVALID_INPUT');
    expect(waitResult.error?.expectedShape).toBeDefined();
    expect(await totalEvents(store)).toBe(before);

    before = await totalEvents(store);
    const exportResult = await handleViewExport({ featureId: unknown }, ctx);
    expect(exportResult.success).toBe(true);
    expect((exportResult.data as { workflowExists?: boolean }).workflowExists).toBe(false);
    expect((exportResult.data as { exported?: boolean }).exported).toBe(false);
    expect(exportResult._meta?.workflowExists).toBe(false);
    expect(await totalEvents(store)).toBe(before);
  });

  /**
   * The shared `scopeField` admits `repo`, but `ps` does not accept it.
   * The error gives the valid scopes and a `suggestedFix` that calls `pipeline` with `scope: 'repo'`.
   * An unknown scope gets the same target list. The rejection appends no event.
   */
  it('Ps_PipelineOnlyScope_InvalidInputWithSuggestedFix', async () => {
    const { store, ctx } = await makeArm();
    const before = await totalEvents(store);

    const repoScoped = await handleViewPs({ scope: 'repo' }, ctx);
    expect(repoScoped.success).toBe(false);
    expect(repoScoped.error?.code).toBe('INVALID_INPUT');
    expect(repoScoped.error?.validTargets).toContain('worktree');
    expect(repoScoped.error?.validTargets).not.toContain('repo');
    expect(repoScoped.error?.suggestedFix?.tool).toBe('exarchos_view');
    expect(repoScoped.error?.suggestedFix?.params).toMatchObject({ action: 'pipeline', scope: 'repo' });

    const bogus = await handleViewPs({ scope: 'nonsense' }, ctx);
    expect(bogus.success).toBe(false);
    expect(bogus.error?.code).toBe('INVALID_INPUT');
    expect(bogus.error?.validTargets).toContain('all');

    expect(await totalEvents(store)).toBe(before);
  });
});
