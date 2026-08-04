// ─── DR-7 / INV-9 — exactly one action mutates a phase ───────────────────────
//
// Acceptance criteria under test:
//   1. `cleanup` and `cancel` route through the single guarded primitive.
//   2. ALL phase mutations are shadow-observed.
//   3. No partial event trail survives a mid-transition failure.
//
// ── Characterization of the behaviour these tests replace ────────────────────
//
// Before this change, `cleanup.ts:303` and `cancel.ts:367` called
// `executeTransition(hsm, mutableState, …)` DIRECTLY. Measured on the
// pre-change tree:
//
//   • `hsmTransitionGuard.attempt` was called ZERO times on the cleanup path —
//     the phase mutation ran with no guard dispatch at all, and therefore with
//     no shadow observation (the observer seam lives inside the primitive).
//     `handleSet` was the only phase mutation the primitive ever saw.
//   • Injecting a failure on the SECOND event append during cleanup left the
//     stream holding exactly `["state.patched"]` — a durable, half-written
//     phase mutation no consumer can distinguish from a complete one.
//   • Cleanup returned `success: true` in the happy path either way, so
//     nothing in the observable result betrayed the bypass.
//
// ── Why the LIVE guarded primitive, and not `runCleanupCommand` ──────────────
//
// `admission/transition-command.ts#runCleanupCommand` was written to close
// exactly this gap and is dead code. It is NOT the right primitive to revive:
//
//   • It lives in the RESERVED admission chokepoint, which its own header
//     stages deliberately — `hsm-transition-guard.ts` "remains the
//     authoritative decider until P07-01 shadow mode reports zero unexplained
//     disagreements and P07-02 migrates the built-in workflows". The cutover
//     gate is NOT satisfied (retirement-safety pins three unmet conditions and
//     zero live attempts). Routing cleanup through it would flip cleanup onto
//     the evidence-backed decider ahead of the cutover — the premature cutover
//     the whole program is staged to prevent.
//   • It evaluates NO guard. It appends a `workflow.cleanup` event under an
//     OCC gate; it never asks `mergeVerified`. Cleanup would lose its guard.
//
// So both handlers route through `hsmTransitionGuard.attempt` — the primitive
// `exarchos_workflow transition` already uses — carrying the SAME
// `recordLiveTransition` shadow observer `tools.ts` wires. That also feeds the
// cutover gate live evidence from the cleanup/cancel edges, which is what the
// staging actually needs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LegacyTransitionObservation } from './admission/shadow-decision.js';

// The shadow seam is observed at its PRODUCTION wiring point: both handlers
// call `recordLiveTransition`, the same function `tools.ts` hands the guarded
// transition path. Mocking the module records every observation that reaches
// production wiring, rather than asserting on the shape of a guard context.
const shadowSpy = vi.hoisted(() => ({
  observations: [] as LegacyTransitionObservation[],
}));

vi.mock('./admission/live-shadow-observer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./admission/live-shadow-observer.js')>();
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

const { handleCleanup } = await import('./cleanup.js');
const { handleCancel } = await import('./cancel.js');
const { handleInit } = await import('./tools.js');
const { EventStore } = await import('../event-store/store.js');
const { hsmTransitionGuard } = await import('./hsm-transition-guard.js');
const { rmrfAsync } = await import('../test-helpers/temp-dir.js');

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

async function readPhase(featureId: string): Promise<unknown> {
  const stateFile = path.join(tmpDir, `${featureId}.state.json`);
  return (JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>).phase;
}

function mockCompensationSuccess(): Promise<void> {
  return import('./compensation.js').then((compensationModule) => {
    vi.spyOn(compensationModule, 'executeCompensation').mockResolvedValue({
      actions: [],
      events: [],
      success: true,
      checkpoint: null,
      durableOutcomes: { completedActionIds: [], outcomeSequences: [] },
    } as unknown as Awaited<ReturnType<typeof compensationModule.executeCompensation>>);
  });
}

// ─── Criterion 1: the single guarded primitive ────────────────────────────────

describe('DR-7 — cleanup and cancel route through the guarded primitive', () => {
  it('Cleanup_CompletedTransition_RoutesThroughGuardedPrimitive', async () => {
    const attemptSpy = vi.spyOn(hsmTransitionGuard, 'attempt');
    await seedWorkflow('cleanup-routes', 'review');
    const store = new EventStore(tmpDir);

    const result = await handleCleanup(
      { featureId: 'cleanup-routes', mergeVerified: true },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).phase).toBe('completed');

    // The phase mutation went through the primitive — exactly once, for the
    // review → completed edge, with the universal-final edge explicitly
    // admitted (the reason the direct-`executeTransition` bypass existed).
    expect(attemptSpy).toHaveBeenCalledTimes(1);
    const [featureId, fromPhase, toPhase, context] = attemptSpy.mock.calls[0]!;
    expect(featureId).toBe('cleanup-routes');
    expect(fromPhase).toBe('review');
    expect(toPhase).toBe('completed');
    expect(context.allowUniversalFinalTransition).toBe(true);
  });

  it('Cleanup_GuardedPrimitiveDenies_PhaseIsNotMutated', async () => {
    // The primitive is AUTHORITATIVE, not decorative: when it denies, cleanup
    // must not mutate the phase and must not write any event. A bypass that
    // merely *also* called the primitive would still pass the routing test
    // above; it cannot pass this one.
    await seedWorkflow('cleanup-denied', 'review');
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

// ─── Criterion 2: all phase mutations are shadow-observed ─────────────────────

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
    await seedWorkflow('cleanup-observed', 'review');
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

// ─── Criterion 3: no partial event trail survives a mid-transition failure ────

/**
 * Install a store failure that lets exactly ONE durable write through and
 * fails every write after it.
 *
 * This is the sharpest possible probe of the all-or-nothing criterion, and it
 * is implementation-agnostic:
 *   - a handler that emits its trail as N sequential appends gets write #1
 *     committed and write #2 rejected, leaving a PARTIAL trail on the stream;
 *   - a handler that commits the whole trail in ONE transaction either lands
 *     all of it in that single permitted write, or lands none of it.
 *
 * Both are exercised against the REAL `EventStore`, the REAL HSM and the REAL
 * guards, so what is asserted is the durable content of the stream — not a
 * spy's call log.
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
  it('Cleanup_MidTransitionFailure_LeavesCompleteTrailOrNothing', async () => {
    await seedWorkflow('cleanup-atomic', 'review', {
      reviews: { 'task-1': { status: 'approved' } },
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

    // The trail is `state.patched` + the HSM lifecycle event(s) + the explicit
    // `workflow.cleanup` completion. Either all of it is durable, or none of
    // it is — never the `["state.patched"]` fragment the bypass produced.
    if (types.length > 0) {
      expect(types).toContain('state.patched');
      expect(types).toContain('workflow.cleanup');
      expect(types.filter((t) => t === 'workflow.cleanup').length).toBeGreaterThanOrEqual(2);
    } else {
      expect(types).toEqual([]);
    }
  });

  it('Cleanup_MidTransitionFailure_PhaseNeverAdvancesPastAnUnwrittenTrail', async () => {
    // The complement of the trail invariant: if the trail did NOT commit, the
    // phase must not have advanced either.
    await seedWorkflow('cleanup-atomic-state', 'review');
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

  it('Cancel_MidTransitionFailure_LeavesCompleteTrailOrNothing', async () => {
    await mockCompensationSuccess();
    await seedWorkflow('cancel-atomic', 'delegate', { _esVersion: 2 });
    const store = new EventStore(tmpDir);

    // Let the cancellation saga (`cancel.ready`) settle first, then interrupt
    // only the final phase-mutation trail — that is the "mid-transition"
    // window this criterion is about.
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
    // No fragment of the cancellation transition trail is durable, and the
    // phase did not advance.
    const events = await store.query('cancel-atomic');
    expect(events.some((e) => e.type === 'workflow.cancel')).toBe(false);
    expect(await readPhase('cancel-atomic')).toBe('delegate');
  });
});
