/**
 * DR-14 (#1647, v2-12-bundle task 013) — context-rot counter + rehydrate
 * gating at the dispatch seam.
 *
 * Three contract pins (task 013 expected tests):
 *   - `RotCounter_EventFold_Pure` — the counter derivation is a pure fold
 *     over events (INV-1): deterministic, input-non-mutating, incremental,
 *     clock-free.
 *   - `NonPhaseMutatingVerb_HighRot_NeverBlocked` — registry-wide: no verb
 *     outside the INV-9 phase-mutating set is EVER hard-blocked, at any
 *     rot level, at any threshold.
 *   - `PhaseMutatingVerb_RotAboveThreshold_StructuredError` — real
 *     `dispatch()` integration: `exarchos_workflow/transition` above the
 *     hard threshold returns a structured `CONTEXT_ROT_EXCEEDED` envelope
 *     naming the rehydrate affordance; the handler never runs; nothing is
 *     thrown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  CONTEXT_ROT_ERROR_CODE,
  CONTEXT_ROT_FOLD_INIT,
  DEFAULT_CONTEXT_ROT_HARD_THRESHOLD,
  DEFAULT_CONTEXT_ROT_SOFT_THRESHOLD,
  PHASE_MUTATING_DISPATCHES,
  WORKFLOW_REHYDRATED_EVENT,
  WORKTREE_CREATED_EVENT,
  applyContextRotEvent,
  applyContextRotSoftSignal,
  foldContextRot,
  isPhaseMutatingDispatch,
  resolveContextRotThresholds,
  runContextRotInterceptor,
  type ContextRotAssessment,
} from './context-rot.js';
import { EventStore } from '../../event-store/store.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { ToolResult } from '../../format.js';
import type { DispatchContext } from '../dispatch.js';
import { getFullRegistry } from '../../registry.js';
import { workflowLogger } from '../../logger.js';
import { __resetMachineryConsumedCache } from './session-machinery.js';
import { configureWorkflowMaterializer, handleSet } from '../../workflow/tools.js';
import { resetMaterializerCache } from '../../views/tools.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

// ─── Synthetic event helper (fold unit tests) ──────────────────────────────

function evt(
  sequence: number,
  type: string,
  data?: Record<string, unknown>,
): WorkflowEvent {
  return Object.freeze({
    streamId: 'rot-stream',
    sequence,
    timestamp: '2026-07-17T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    ...(data !== undefined ? { data } : {}),
  }) as WorkflowEvent;
}

/** N benign events starting at `startSeq` (each is a plain rot increment). */
function benign(startSeq: number, count: number): WorkflowEvent[] {
  return Array.from({ length: count }, (_, i) =>
    evt(startSeq + i, 'workflow.checkpoint', {
      counter: i,
      phase: 'plan',
      featureId: 'rot-stream',
    }),
  );
}

// ─── Real-store helpers (interceptor + dispatch integration) ───────────────

let tmpDir: string;
let eventStore: EventStore;

function ctx(): DispatchContext {
  return { stateDir: tmpDir, eventStore, enableTelemetry: false };
}

async function seedCheckpoints(streamId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await eventStore.append(streamId, {
      type: 'workflow.checkpoint',
      data: { counter: i, phase: 'plan', featureId: streamId },
    });
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-rot-test-'));
  eventStore = new EventStore(tmpDir);
  await eventStore.initialize();
  __resetMachineryConsumedCache();
  configureWorkflowMaterializer(null);
  resetMaterializerCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  configureWorkflowMaterializer(null);
  resetMaterializerCache();
  await rmrfAsync(tmpDir);
});

// ─── Pure fold (INV-1) ─────────────────────────────────────────────────────

describe('context-rot fold (INV-1 — pure derivation over events)', () => {
  it('RotCounter_EventFold_Pure', () => {
    const events: readonly WorkflowEvent[] = Object.freeze([
      evt(1, 'workflow.started', { featureId: 'rot-stream', workflowType: 'feature' }),
      ...benign(2, 3),
      evt(5, 'workflow.rehydrated', {
        projectionSequence: 4,
        deliveryPath: 'direct',
        tokenEstimate: 0,
      }),
      ...benign(6, 4),
    ]);

    // Clock-free: the fold must never read the clock (INV-1 — no hidden
    // time dependence; two replays of the same log agree forever).
    const nowSpy = vi.spyOn(Date, 'now');

    // Deterministic: same input, same output — across repeated calls.
    const first = foldContextRot(events);
    const second = foldContextRot(events);
    expect(first).toEqual(second);
    expect(first).toEqual({ anchorSequence: 5, rot: 4 });

    // Incremental-fold identity: fold(all) === fold(tail, fold(head)).
    // This is what lets the interceptor fold only the post-anchor window.
    for (const split of [0, 1, 4, 5, events.length]) {
      const head = events.slice(0, split);
      const tail = events.slice(split);
      expect(foldContextRot(tail, foldContextRot(head))).toEqual(first);
    }

    // Non-mutating: inputs (frozen) and the seed are untouched; the reducer
    // returns fresh state objects rather than mutating in place.
    const seed = Object.freeze({ anchorSequence: 0, rot: 0 });
    const out = applyContextRotEvent(seed, events[0]!);
    expect(out).not.toBe(seed);
    expect(seed).toEqual({ anchorSequence: 0, rot: 0 });
    expect(CONTEXT_ROT_FOLD_INIT).toEqual({ anchorSequence: 0, rot: 0 });

    // Empty fold is the identity.
    expect(foldContextRot([])).toEqual(CONTEXT_ROT_FOLD_INIT);
    expect(foldContextRot([], first)).toEqual(first);

    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('Fold_RehydratedEvent_ResetsRotAndAnchorsAtOwnSequence', () => {
    const state = foldContextRot([
      ...benign(1, 10),
      evt(11, 'workflow.rehydrated', {
        projectionSequence: 10,
        deliveryPath: 'direct',
        tokenEstimate: 0,
      }),
    ]);
    // Anchor is the event's OWN store sequence (T-12 convention), not the
    // embedded data.projectionSequence.
    expect(state).toEqual({ anchorSequence: 11, rot: 0 });
  });

  it('Fold_LauncherSpawnAnchor_SeedsRotFromProjectionSequence', () => {
    // DR-13 launcher-shaped worktree.created: the spawn envelope's
    // projectionSequence is the rehydration doc's staleness anchor — events
    // between that fold position and the spawn are already rot at spawn.
    const launcherSpawn = evt(9, 'worktree.created', {
      path: '/tmp/wt',
      worktreeId: 'wt-1',
      treeHash: 'abc123',
      commit: 'def456',
      projectionSequence: 5,
      posture: 'task-isolated',
    });
    const state = foldContextRot([...benign(1, 8), launcherSpawn]);
    expect(state).toEqual({ anchorSequence: 5, rot: 4 }); // events 6,7,8 + the spawn itself

    // Task-shaped worktree.created carries NO projectionSequence — it is a
    // plain rot increment, never an anchor.
    const taskShaped = evt(3, 'worktree.created', {
      taskId: 't1',
      path: '/tmp/wt',
      branch: 'task/t1',
    });
    expect(foldContextRot([...benign(1, 2), taskShaped])).toEqual({
      anchorSequence: 0,
      rot: 3,
    });

    // A stale launcher anchor (projectionSequence behind the current
    // anchor) must not rewind freshness — plain increment.
    const staleSpawn = evt(12, 'worktree.created', {
      path: '/tmp/wt2',
      worktreeId: 'wt-2',
      treeHash: 'abc',
      commit: 'def',
      projectionSequence: 2,
      posture: 'task-isolated',
    });
    const rehydratedAt10 = evt(10, 'workflow.rehydrated', {
      projectionSequence: 9,
      deliveryPath: 'direct',
      tokenEstimate: 0,
    });
    expect(
      foldContextRot([...benign(1, 9), rehydratedAt10, evt(11, 'workflow.checkpoint', { counter: 0, phase: 'plan', featureId: 'rot-stream' }), staleSpawn]),
    ).toEqual({ anchorSequence: 10, rot: 2 });
  });
});

// ─── Hard gate (INV-9 scope) ───────────────────────────────────────────────

describe('context-rot hard gate (INV-9 — phase mutations only)', () => {
  it('NonPhaseMutatingVerb_HighRot_NeverBlocked', async () => {
    // Registry-wide contract (issue #1647: "a contract/parity test asserting
    // reads are never gated at any counter value"): with rot far above a
    // pathologically-low hard threshold, EVERY action outside the INV-9
    // phase-mutating set must come back unblocked.
    const streamId = 'rot-never-blocked';
    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    await seedCheckpoints(streamId, 11); // rot = 12 with no anchor

    const paranoid = { soft: 1, hard: 1 }; // any rot ≥ 1 would block, if gated
    let checked = 0;
    for (const tool of getFullRegistry()) {
      for (const action of tool.actions) {
        if (isPhaseMutatingDispatch(tool.name, action.name)) continue;
        const assessment = await runContextRotInterceptor(
          eventStore,
          streamId,
          tool.name,
          action.name,
          paranoid,
        );
        if (action.name === 'rehydrate') {
          // The re-grounding affordance itself is never metered.
          expect(assessment).toBeUndefined();
          continue;
        }
        expect(assessment).toBeDefined();
        expect(assessment!.rot).toBeGreaterThanOrEqual(12);
        expect(assessment!.blocked).toBeNull();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50); // the sweep actually swept

    // Sanity (non-vacuous loop): the ONE phase-mutating dispatch IS blocked
    // under identical conditions.
    expect(PHASE_MUTATING_DISPATCHES.has('exarchos_workflow/transition')).toBe(true);
    const gated = await runContextRotInterceptor(
      eventStore,
      streamId,
      'exarchos_workflow',
      'transition',
      paranoid,
    );
    expect(gated?.blocked).not.toBeNull();
    expect(gated?.blocked?.error?.code).toBe(CONTEXT_ROT_ERROR_CODE);
  });

  it('PhaseMutatingVerb_RotAboveThreshold_StructuredError', async () => {
    // Real dispatch-seam integration: the gate fires INSIDE dispatch(),
    // returns a structured envelope (never a throw-through), and the
    // transition handler never runs.
    vi.stubEnv('EXARCHOS_CONTEXT_ROT_HARD_THRESHOLD', '5');
    const { dispatch } = await import('../dispatch.js');
    const featureId = 'rot-hard-gate';

    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await seedCheckpoints(featureId, 8); // rot well above the stubbed hard threshold

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(CONTEXT_ROT_ERROR_CODE);
    expect(result.error?.tool).toBe('exarchos_workflow');
    expect(result.error?.action).toBe('transition');
    expect(result.error?.threshold).toBe(5);
    expect(result.error?.operationsSince).toBeGreaterThanOrEqual(5);
    // The envelope NAMES the rehydrate affordance — machine-actionable fix
    // pointer plus a first-class next_actions entry.
    expect(result.error?.suggestedFix).toEqual({
      tool: 'exarchos_workflow',
      params: { action: 'rehydrate', featureId },
    });
    expect(result.next_actions?.[0]?.verb).toBe('rehydrate');
    // Correlation _meta still attached (the block flows through attachMeta).
    expect(result._meta).toMatchObject({ operationId: expect.any(String) });

    // The handler never ran: no workflow.transition event landed.
    const transitions = await eventStore.query(featureId, { type: 'workflow.transition' });
    expect(transitions).toHaveLength(0);
  });

  it('PhaseMutatingVerb_RotBelowThreshold_ProceedsToHandler', async () => {
    const { dispatch } = await import('../dispatch.js');
    const featureId = 'rot-below-threshold';

    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);

    // Satisfy the plan → plan-review HSM guard (artifacts.plan) so the
    // transition exercises the FULL post-gate path.
    const c = ctx();
    await handleSet(
      { featureId, updates: { 'artifacts.plan': 'docs/specs/x.md' } },
      c.stateDir,
      c.eventStore,
    );

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      c,
    );
    expect(result.error?.code).not.toBe(CONTEXT_ROT_ERROR_CODE);
    expect(result.success).toBe(true);
  });

  it('RehydratedEvent_ResetsCounter_UnblocksPhaseMutation', async () => {
    vi.stubEnv('EXARCHOS_CONTEXT_ROT_HARD_THRESHOLD', '5');
    const { dispatch } = await import('../dispatch.js');
    const featureId = 'rot-reset';

    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await seedCheckpoints(featureId, 8);

    // Above threshold → blocked.
    const blocked = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(blocked.error?.code).toBe(CONTEXT_ROT_ERROR_CODE);

    // A workflow.rehydrated landing resets the counter (anchor at its own
    // sequence) — the phase mutation is no longer rot-gated. It may still
    // fail the HSM guard (unset artifacts.plan); the contract here is that
    // the ROT gate released.
    await eventStore.append(featureId, {
      type: 'workflow.rehydrated',
      data: { projectionSequence: 10, deliveryPath: 'direct', tokenEstimate: 0 },
    });
    const released = await dispatch(
      'exarchos_workflow',
      { action: 'transition', featureId, target: 'plan-review' },
      ctx(),
    );
    expect(released.error?.code).not.toBe(CONTEXT_ROT_ERROR_CODE);
  });
});

// ─── Bounded read (INV-17 — never materialize the whole stream) ─────────────

describe('context-rot interceptor bounded read (INV-17 — no whole-stream load)', () => {
  it('UnanchoredStream_LongHistory_TailReadBounded', async () => {
    // The defect this pins: for an un-anchored stream (no workflow.rehydrated,
    // no qualifying launcher worktree.created) `anchorSequence` is 0, so the
    // old `query({ sinceSequence: 0 })` tail read materialized the ENTIRE
    // stream on EVERY dispatch — an O(stream) per-dispatch tax contradicting
    // INV-17 and DR-11. The rot magnitude is now a `SELECT COUNT(*)` over the
    // post-anchor window: zero rows materialized, gate decision unchanged.
    const streamId = 'rot-bounded-tail';
    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    const hard = 5;
    const historyLen = hard * 40; // far more than the hard threshold
    await seedCheckpoints(streamId, historyLen);
    const totalEvents = historyLen + 1; // workflow.started + checkpoints

    // Spy-through: record the filters each read is invoked with while still
    // running the real store.
    const querySpy = vi.spyOn(eventStore, 'query');
    const countSpy = vi.spyOn(eventStore, 'count');

    const assessment = await runContextRotInterceptor(
      eventStore,
      streamId,
      'exarchos_workflow',
      'transition',
      { soft: 1, hard },
    );

    // Gate decision is unchanged: an un-anchored long stream hard-blocks the
    // phase-mutating verb, and rot is the EXACT post-anchor event count.
    expect(assessment).toBeDefined();
    expect(assessment!.anchorSequence).toBe(0); // no freshness anchor
    expect(assessment!.rot).toBe(totalEvents);
    expect(assessment!.rot).toBeGreaterThanOrEqual(hard);
    expect(assessment!.blocked).not.toBeNull();
    expect(assessment!.blocked?.error?.code).toBe(CONTEXT_ROT_ERROR_CODE);

    // The rot magnitude came from a bounded COUNT over the post-anchor window
    // (materializes no rows), not a tail materialization.
    expect(countSpy).toHaveBeenCalledWith(streamId, { sinceSequence: 0 });

    // The ONLY `query` the interceptor issues is the type-filtered anchor scan
    // — bounded to anchor-typed events, never the whole stream. Crucially,
    // NO `query` call is an unbounded `{ sinceSequence }`-only tail read.
    expect(querySpy).toHaveBeenCalled();
    for (const [, filters] of querySpy.mock.calls) {
      expect(filters?.types).toEqual([
        WORKFLOW_REHYDRATED_EVENT,
        WORKTREE_CREATED_EVENT,
      ]);
      expect(filters?.sinceSequence).toBeUndefined();
    }
  });

  it('LauncherAnchor_TailReadStaysBounded_ResetIsNoOp', async () => {
    // Anchor-in-tail edge: a launcher worktree.created whose projectionSequence
    // EQUALS the current anchor sits strictly after it in the tail. The bound
    // must still be exact — the reset re-derives rot to its own contiguous
    // post-anchor position, identical to a plain increment (fold-rot ≡ count).
    const streamId = 'rot-bounded-anchor-tail';
    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    // A launcher spawn anchors freshness at its projectionSequence (= 1, the
    // workflow.started fold position).
    await eventStore.append(streamId, {
      type: WORKTREE_CREATED_EVENT,
      data: {
        path: '/tmp/wt',
        worktreeId: 'wt-1',
        treeHash: 'abc123',
        commit: 'def456',
        projectionSequence: 1,
        posture: 'task-isolated',
      },
    });
    // A SECOND launcher spawn with projectionSequence == the current anchor (1)
    // lands later — a qualifying reset event sitting in the tail.
    await eventStore.append(streamId, {
      type: WORKTREE_CREATED_EVENT,
      data: {
        path: '/tmp/wt2',
        worktreeId: 'wt-2',
        treeHash: 'aaa',
        commit: 'bbb',
        projectionSequence: 1,
        posture: 'task-isolated',
      },
    });
    await seedCheckpoints(streamId, 20);

    // Ground truth: fold the whole stream directly. The bounded interceptor
    // must agree with it exactly.
    const allEvents = await eventStore.query(streamId);
    const foldTruth = foldContextRot(allEvents);

    const countSpy = vi.spyOn(eventStore, 'count');
    const assessment = await runContextRotInterceptor(
      eventStore,
      streamId,
      'exarchos_workflow',
      'transition',
      { soft: 1, hard: 5 },
    );

    expect(assessment).toBeDefined();
    expect(assessment!.anchorSequence).toBe(foldTruth.anchorSequence);
    expect(assessment!.rot).toBe(foldTruth.rot); // count ≡ fold, reset is a no-op
    // Bounded: rot came from a COUNT over the post-anchor window.
    expect(countSpy).toHaveBeenCalledWith(streamId, {
      sinceSequence: foldTruth.anchorSequence,
    });
  });
});

// ─── Soft signal ───────────────────────────────────────────────────────────

describe('context-rot soft signal (rehydrate promotion, advisory)', () => {
  const assessmentAt = (rot: number): ContextRotAssessment => ({
    streamId: 'rot-soft',
    rot,
    anchorSequence: 0,
    thresholds: { soft: 10, hard: 50 },
    blocked: null,
  });

  it('SoftSignal_PromotesRehydrateAffordance_TopOfNextActions', () => {
    const base: ToolResult = {
      success: true,
      data: { ok: true },
      next_actions: [{ verb: 'plan-review', reason: 'HSM affordance' }],
    };

    // At/above the soft threshold: rehydrate lands FIRST and the counter is
    // surfaced as a visible number on _meta.contextRot.
    const decorated = applyContextRotSoftSignal(base, assessmentAt(10));
    expect(decorated.next_actions?.[0]?.verb).toBe('rehydrate');
    expect(decorated.next_actions).toHaveLength(2);
    expect(decorated.next_actions?.[1]?.verb).toBe('plan-review');
    expect((decorated._meta as Record<string, unknown>).contextRot).toBe(10);

    // A handler-authored rehydrate entry is HOISTED, not duplicated.
    const withOwn: ToolResult = {
      success: true,
      data: {},
      next_actions: [
        { verb: 'plan-review', reason: 'HSM affordance' },
        { verb: 'rehydrate', reason: 'handler-authored' },
      ],
    };
    const hoisted = applyContextRotSoftSignal(withOwn, assessmentAt(12));
    expect(hoisted.next_actions?.map((a) => a.verb)).toEqual(['rehydrate', 'plan-review']);
    expect(hoisted.next_actions?.[0]?.reason).toBe('handler-authored');

    // Below the soft threshold / failed result / no assessment: unchanged
    // (same reference — pure no-op decoration).
    expect(applyContextRotSoftSignal(base, assessmentAt(9))).toBe(base);
    expect(applyContextRotSoftSignal(base, undefined)).toBe(base);
    const failed: ToolResult = { success: false, error: { code: 'X', message: 'x' } };
    expect(applyContextRotSoftSignal(failed, assessmentAt(99))).toBe(failed);
  });

  it('SoftSignal_DispatchIntegration_ReadCarriesAffordanceUnblocked', async () => {
    // Read verb at high rot through the REAL dispatch: never blocked
    // (INV-9), but the response promotes rehydrate and surfaces the number.
    vi.stubEnv('EXARCHOS_CONTEXT_ROT_SOFT_THRESHOLD', '3');
    const { dispatch } = await import('../dispatch.js');
    const featureId = 'rot-soft-integration';

    const init = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx(),
    );
    expect(init.success).toBe(true);
    await seedCheckpoints(featureId, 6);

    const result = await dispatch(
      'exarchos_workflow',
      { action: 'get', featureId },
      ctx(),
    );
    expect(result.success).toBe(true); // reads are NEVER gated
    expect(result.error).toBeUndefined();
    expect(result.next_actions?.[0]?.verb).toBe('rehydrate');
    const meta = result._meta as Record<string, unknown>;
    expect(typeof meta.contextRot).toBe('number');
    expect(meta.contextRot as number).toBeGreaterThanOrEqual(3);
    // attachMeta's correlation block survives around the stamp.
    expect(typeof meta.operationId).toBe('string');
  });
});

// ─── Failure posture + short-circuits ──────────────────────────────────────

describe('context-rot interceptor failure posture', () => {
  it('StoreReadFailure_FailsOpen_LogsWarn', async () => {
    const warnSpy = vi.spyOn(workflowLogger, 'warn').mockImplementation(() => undefined);
    const failingStore = {
      query: vi.fn().mockRejectedValue(new Error('boom — synthetic store failure')),
    } as unknown as EventStore;

    // Fail-open: never a throw-through, never a block — dispatch proceeds.
    await expect(
      runContextRotInterceptor(failingStore, 'rot-fail', 'exarchos_workflow', 'transition'),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logCtx, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(logCtx).toMatchObject({
      streamId: 'rot-fail',
      tool: 'exarchos_workflow',
      actionVerb: 'transition',
    });
    expect(logCtx).toHaveProperty('err');
    expect(message).toMatch(/context-rot interceptor swallowed error/i);
  });

  it('Interceptor_ShortCircuits_NoStreamAndRehydrateVerb', async () => {
    const query = vi.fn();
    const store = { query } as unknown as EventStore;

    // No stream to meter.
    expect(
      await runContextRotInterceptor(store, undefined, 'exarchos_workflow', 'get'),
    ).toBeUndefined();
    // The re-grounding verb itself is never metered (gating the cure on the
    // disease would deadlock recovery).
    expect(
      await runContextRotInterceptor(store, 'rot-x', 'exarchos_workflow', 'rehydrate'),
    ).toBeUndefined();
    // Both signals disabled → the read cost is skipped entirely.
    expect(
      await runContextRotInterceptor(store, 'rot-x', 'exarchos_workflow', 'get', {
        soft: 0,
        hard: 0,
      }),
    ).toBeUndefined();

    expect(query).not.toHaveBeenCalled();
  });

  it('Thresholds_EnvOverridesAndDisables_Resolve', () => {
    expect(resolveContextRotThresholds()).toEqual({
      soft: DEFAULT_CONTEXT_ROT_SOFT_THRESHOLD,
      hard: DEFAULT_CONTEXT_ROT_HARD_THRESHOLD,
    });

    vi.stubEnv('EXARCHOS_CONTEXT_ROT_SOFT_THRESHOLD', '7');
    vi.stubEnv('EXARCHOS_CONTEXT_ROT_HARD_THRESHOLD', '0'); // 0 disables
    expect(resolveContextRotThresholds()).toEqual({
      soft: 7,
      hard: Number.POSITIVE_INFINITY,
    });

    // Explicit overrides beat the environment; junk env falls back.
    expect(resolveContextRotThresholds({ soft: 2, hard: 3 })).toEqual({ soft: 2, hard: 3 });
    vi.stubEnv('EXARCHOS_CONTEXT_ROT_SOFT_THRESHOLD', 'not-a-number');
    expect(resolveContextRotThresholds().soft).toBe(DEFAULT_CONTEXT_ROT_SOFT_THRESHOLD);
  });
});
