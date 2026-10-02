// Tests for the phase mutations of `cleanup` and `cancel`.
// Both handlers route through `hsmTransitionGuard.attempt`, the guarded primitive that `exarchos_workflow transition` also uses.
// Both report each transition to the `recordLiveTransition` shadow observer.
// A failure in the middle of a transition leaves no partial event trail.
//
// The handlers do not use `runCleanupCommand` from `admission/transition-command.ts`.
// That function evaluates no guard, so cleanup loses its `mergeVerified` check.
// It also belongs to the admission chokepoint, which is not the authoritative decider before the cutover.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LegacyTransitionObservation } from '../../../src/workflow/admission/shadow-decision.js';

/**
 * Records each observation that reaches `recordLiveTransition`, the production observer that both handlers and `handleSet` call.
 * The mock records what reaches the production wiring, not the shape of a guard context.
 */
const shadowSpy = vi.hoisted(() => ({
  observations: [] as LegacyTransitionObservation[],
}));

vi.mock('../../../src/workflow/admission/live-shadow-observer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/workflow/admission/live-shadow-observer.js')>();
  return {
    ...actual,
    recordLiveTransition: (
      observation: LegacyTransitionObservation,
      state: Record<string, unknown>,
    ): void => {
      shadowSpy.observations.push(observation);
      actual.recordLiveTransition(observation, state);
    },
  };
});

const { handleCleanup } = await import('../../../src/workflow/cleanup.js');
const { handleCancel } = await import('../../../src/workflow/cancel.js');
const { handleInit } = await import('../../../src/workflow/tools.js');
const { EventStore } = await import('../../../src/events/store.js');
const { hsmTransitionGuard } = await import('../../../src/workflow/hsm-transition-guard.js');
const { rmrfAsync } = await import('../../../tools/test-helpers/temp-dir.js');

type EventStoreInstance = InstanceType<typeof EventStore>;

let tmpDir: string;

beforeEach(async () => {
  shadowSpy.observations.length = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr7-phase-mutation-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rmrfAsync(tmpDir);
});

async function seedWorkflow(
  featureId: string,
  phase: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await handleInit({ featureId, workflowType: 'feature' }, tmpDir, null);
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  raw.phase = phase;
  raw._history = { feature: phase };
  Object.assign(raw, extra);
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

/**
 * Builds a schema-complete `synthesis` block that holds a merge record.
 * `collectCleanupEvidence` reads this evidence from the state, not from the `prUrl` input.
 */
function mergeEvidenceSynthesis(prUrl: string): Record<string, unknown> {
  return {
    integrationBranch: null,
    mergeOrder: [],
    mergedBranches: [],
    prUrl,
    prFeedback: [],
  };
}

async function readPhase(featureId: string): Promise<unknown> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return (JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>).phase;
}

function mockCompensationSuccess(): Promise<void> {
  return import('../../../src/workflow/compensation.js').then((compensationModule) => {
    vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
      actions: [],
      events: [],
      success: true,
      checkpoint: null,
      durableOutcomes: { completedActionIds: [], outcomeSequences: [] },
    } as unknown as Awaited<ReturnType<typeof compensationModule.executeCompensation>>);
  });
}

describe('DR-7 — cleanup and cancel route through the guarded primitive', () => {
  /** Cleanup calls the primitive once, for the review to completed edge, and admits the universal final transition. */
  it('Cleanup_CompletedTransition_RoutesThroughGuardedPrimitive', async () => {
    const attemptSpy = vi.spyOn(hsmTransitionGuard, 'attempt');
    await seedWorkflow('cleanup-routes', 'review', {
      synthesis: mergeEvidenceSynthesis('https://github.com/test/pr/1'),
    });
    const store = new EventStore(tmpDir);

    const result = await handleCleanup(
      { featureId: 'cleanup-routes', mergeVerified: true },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).phase).toBe('completed');

    expect(attemptSpy).toHaveBeenCalledTimes(1);
    const [featureId, fromPhase, toPhase, context] = attemptSpy.mock.calls[0]!;
    expect(featureId).toBe('cleanup-routes');
    expect(fromPhase).toBe('review');
    expect(toPhase).toBe('completed');
    expect(context.allowUniversalFinalTransition).toBe(true);
  });

  /**
   * When the primitive denies, cleanup changes neither the phase nor the stream.
   * A handler that calls the primitive but ignores it passes the routing test, but it fails this test.
   * The seeded merge evidence makes the injected denial the only cause of failure.
   */
  it('Cleanup_GuardedPrimitiveDenies_PhaseIsNotMutated', async () => {
    await seedWorkflow('cleanup-denied', 'review', {
      synthesis: mergeEvidenceSynthesis('https://github.com/test/pr/1'),
    });
    const store = new EventStore(tmpDir);
    const before = (await store.query('cleanup-denied')).length;

    vi.spyOn(hsmTransitionGuard, 'attempt').mockResolvedValue({
      ok: false,
      reason: 'guard-failed',
      failures: [{ passed: false, reason: 'injected denial' }],
      guardId: 'merge-verified',
      errorCode: 'GUARD_FAILED',
      errorMessage: 'injected denial',
    });

    const result = await handleCleanup(
      { featureId: 'cleanup-denied', mergeVerified: true },
      tmpDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('injected denial');
    expect(await readPhase('cleanup-denied')).toBe('review');
    expect((await store.query('cleanup-denied')).length).toBe(before);
  });

  it('Cancel_CancelledTransition_RoutesThroughGuardedPrimitive', async () => {
    await mockCompensationSuccess();
    const attemptSpy = vi.spyOn(hsmTransitionGuard, 'attempt');
    await seedWorkflow('cancel-routes', 'delegate', { _esVersion: 2 });
    const store = new EventStore(tmpDir);

    const result = await handleCancel({ featureId: 'cancel-routes' }, tmpDir, store);

    expect(result.success).toBe(true);
    expect(await readPhase('cancel-routes')).toBe('cancelled');
    expect(attemptSpy).toHaveBeenCalledTimes(1);
    const [featureId, fromPhase, toPhase, context] = attemptSpy.mock.calls[0]!;
    expect(featureId).toBe('cancel-routes');
    expect(fromPhase).toBe('delegate');
    expect(toPhase).toBe('cancelled');
    expect(context.allowUniversalFinalTransition).toBe(true);
  });
});

describe('DR-7 — every phase mutation is shadow-observed', () => {
  it('Cancel_CancelledTransition_IsShadowObserved', async () => {
    await mockCompensationSuccess();
    await seedWorkflow('cancel-observed', 'delegate', { _esVersion: 2 });
    const store = new EventStore(tmpDir);

    const result = await handleCancel({ featureId: 'cancel-observed' }, tmpDir, store);

    expect(result.success).toBe(true);
    expect(shadowSpy.observations).toContainEqual(
      expect.objectContaining({
        workflowType: 'feature',
        fromPhase: 'delegate',
        toPhase: 'cancelled',
        legacyOutcome: 'allow',
      }),
    );
  });

  it('Cleanup_CompletedTransition_IsShadowObserved', async () => {
    await seedWorkflow('cleanup-observed', 'review', {
      synthesis: mergeEvidenceSynthesis('https://github.com/test/pr/1'),
    });
    const store = new EventStore(tmpDir);

    const result = await handleCleanup(
      { featureId: 'cleanup-observed', mergeVerified: true },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    expect(shadowSpy.observations).toContainEqual(
      expect.objectContaining({
        workflowType: 'feature',
        fromPhase: 'review',
        toPhase: 'completed',
        legacyOutcome: 'allow',
      }),
    );
  });
});

/**
 * Lets exactly one durable write through and fails every later write.
 * A handler that appends its trail one event at a time leaves a partial trail.
 * A handler that commits the trail in one transaction lands all of it or none of it.
 * The tests use the real `EventStore`, HSM, and guards, and check the durable stream.
 */
function failAfterFirstWrite(store: EventStoreInstance): void {
  let writes = 0;
  const realAppend = store.append.bind(store);
  const realTrail = store.appendTrailAtomically.bind(store);
  const gate = <TArgs extends unknown[], TResult>(
    real: (...args: TArgs) => Promise<TResult>,
  ) => async (...args: TArgs): Promise<TResult> => {
    writes += 1;
    if (writes > 1) throw new Error('injected mid-transition failure');
    return real(...args);
  };
  vi.spyOn(store, 'append').mockImplementation(gate(realAppend));
  vi.spyOn(store, 'appendTrailAtomically').mockImplementation(gate(realTrail));
}

describe('DR-7 — no partial event trail survives a mid-transition failure', () => {
  /**
   * The trail is `state.patched`, the HSM lifecycle events, and the explicit `workflow.cleanup` event.
   * Either all of it is durable or none of it is.
   */
  it('Cleanup_MidTransitionFailure_LeavesCompleteTrailOrNothing', async () => {
    await seedWorkflow('cleanup-atomic', 'review', {
      reviews: { 'task-1': { status: 'approved' } },
      synthesis: mergeEvidenceSynthesis('https://github.com/test/pr/7'),
    });
    const store = new EventStore(tmpDir);
    const before = await store.query('cleanup-atomic');

    failAfterFirstWrite(store);

    await handleCleanup(
      {
        featureId: 'cleanup-atomic',
        mergeVerified: true,
        prUrl: 'https://github.com/test/pr/7',
        mergedBranches: ['feature/task-1'],
      },
      tmpDir,
      store,
    );

    vi.restoreAllMocks();
    const added = (await store.query('cleanup-atomic')).slice(before.length);
    const types = added.map((event) => event.type);

    if (types.length > 0) {
      expect(types).toContain('state.patched');
      expect(types).toContain('workflow.cleanup');
      expect(types.filter((t) => t === 'workflow.cleanup').length).toBeGreaterThanOrEqual(2);
    } else {
      expect(types).toEqual([]);
    }
  });

  /** When the trail does not commit, the phase does not advance. */
  it('Cleanup_MidTransitionFailure_PhaseNeverAdvancesPastAnUnwrittenTrail', async () => {
    await seedWorkflow('cleanup-atomic-state', 'review', {
      synthesis: mergeEvidenceSynthesis('https://github.com/test/pr/1'),
    });
    const store = new EventStore(tmpDir);
    const before = (await store.query('cleanup-atomic-state')).length;

    vi.spyOn(store, 'appendTrailAtomically').mockRejectedValue(
      new Error('injected mid-transition failure'),
    );

    const result = await handleCleanup(
      { featureId: 'cleanup-atomic-state', mergeVerified: true },
      tmpDir,
      store,
    );

    vi.restoreAllMocks();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(await readPhase('cleanup-atomic-state')).toBe('review');
    expect((await store.query('cleanup-atomic-state')).length).toBe(before);
  });

  /**
   * The saga, up to `cancel.ready`, does not write through `appendTrailAtomically`.
   * Thus the first call to it is the final phase-mutation trail, and the test fails that call.
   * No part of the cancel transition trail is durable, and the phase does not advance.
   */
  it('Cancel_MidTransitionFailure_LeavesCompleteTrailOrNothing', async () => {
    await mockCompensationSuccess();
    await seedWorkflow('cancel-atomic', 'delegate', { _esVersion: 2 });
    const store = new EventStore(tmpDir);

    const realTrail = store.appendTrailAtomically.bind(store);
    let trailWrites = 0;
    vi.spyOn(store, 'appendTrailAtomically').mockImplementation(async (...args) => {
      trailWrites += 1;
      if (trailWrites === 1) throw new Error('injected mid-transition failure');
      return realTrail(...args);
    });

    const result = await handleCancel({ featureId: 'cancel-atomic' }, tmpDir, store);

    vi.restoreAllMocks();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    const events = await store.query('cancel-atomic');
    expect(events.some((e) => e.type === 'workflow.cancel')).toBe(false);
    expect(await readPhase('cancel-atomic')).toBe('delegate');
  });
});
