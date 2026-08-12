// Co-located unit tests for `nextActionsFromResult` (#1208 / DR-MO-1).
//
// Two payload shapes must be recognised:
//
//   1. Workflow-handler shape (`handleInit`/`handleGet`/`handleSet`):
//      `{ phase, workflowType, ... }` at the top level.
//   2. Rehydration document shape (`handleRehydrate`):
//      `{ workflowState: { phase, workflowType, featureId, mergeOrchestrator } }`.
//
// Pre-fix only shape 1 was extracted, so rehydrate envelopes always returned
// `next_actions: []` even when the merge-pending detour was active. These
// tests pin shape 2 + the merge_orchestrate surfacing branch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { z } from 'zod';
import {
  nextActionsFromResult,
  nextActionsLogger,
  ResultDataSchema,
} from './next-actions-from-result.js';
import type { ToolResult } from './format.js';
import { rehydrationReducer } from './projections/rehydration/reducer.js';
import type { WorkflowEvent } from './events/schemas.js';
import { RehydrationMergeOrchestratorSchema } from './projections/rehydration/schema.js';
import { MergeOrchestratorStateSchema } from './workflow/schemas.js';

function ok(data: unknown): ToolResult {
  return { success: true, data };
}

describe('nextActionsFromResult — shape recognition', () => {
  it('returns [] for non-success results', () => {
    const result: ToolResult = {
      success: false,
      error: { code: 'X', message: 'no' },
    };
    expect(nextActionsFromResult(result)).toEqual([]);
  });

  it('returns [] when payload lacks phase + workflowType', () => {
    expect(nextActionsFromResult(ok({}))).toEqual([]);
    expect(nextActionsFromResult(ok({ random: 'thing' }))).toEqual([]);
    expect(nextActionsFromResult(ok(null))).toEqual([]);
  });

  it('extracts shape 1 (handler payload) — phase + workflowType at top level', () => {
    const actions = nextActionsFromResult(
      ok({ phase: 'plan', workflowType: 'feature' }),
    );
    // DR-4 (#1581): `plan → plan-review` is the sole explicit transition out of `plan`.
    expect(actions.map((a) => a.verb)).toEqual(['plan-review']);
  });

  it('extracts shape 2 (rehydration document) — workflowState segment', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'feat-x',
          phase: 'plan',
          workflowType: 'feature',
        },
      }),
    );
    expect(actions.map((a) => a.verb)).toEqual(['plan-review']);
  });

  it('surfaces merge_orchestrate from shape 2 when phase is merge-pending', () => {
    // Pre-fix this returned [] because shape 2 was not recognised. With
    // shape-2 recognition in place, the `merge-pending` substate's
    // `merge_orchestrate` verb is surfaced (idempotency-keyed by
    // `<featureId>:merge_orchestrate:<taskId>`).
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'p2-detour',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '001', phase: 'pending' },
        },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
    const mo = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(mo?.idempotencyKey).toBe('p2-detour:merge_orchestrate:001');
  });

  it('does NOT surface merge_orchestrate when mergeOrchestrator phase is terminal', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'p2-detour',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '001', phase: 'completed' },
        },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(false);
  });

  it('prefers shape 1 when both shapes could match', () => {
    // Top-level fields take precedence for phase / workflowType — keeps the
    // cheap, common path unchanged for handler payloads that happen to
    // include a workflowState sibling for downstream consumers.
    const actions = nextActionsFromResult(
      ok({
        phase: 'plan',
        workflowType: 'feature',
        workflowState: {
          featureId: 'x',
          phase: 'merge-pending',
          workflowType: 'feature',
        },
      }),
    );
    expect(actions.map((a) => a.verb)).toEqual(['plan-review']);
  });

  it('backfills mergeOrchestrator from workflowState when shape 1 supplies phase', () => {
    // Coderabbit P2-saga: shape 1 (handler payload) carries phase +
    // workflowType at the top level but not mergeOrchestrator — that field
    // lives on the workflowState segment. Without backfill, a payload with
    // top-level phase='merge-pending' + nested workflowState.mergeOrchestrator
    // would drop the orchestration context and miss `merge_orchestrate`.
    const actions = nextActionsFromResult(
      ok({
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'p2-backfill',
        workflowState: {
          featureId: 'p2-backfill',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '042', phase: 'pending' },
        },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
    const mo = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(mo?.idempotencyKey).toBe('p2-backfill:merge_orchestrate:042');
  });

  it('reads mergeOrchestrator at top level when shape 1 carries it directly', () => {
    // Defensive: if a future handler ever returns mergeOrchestrator at the
    // top level (alongside phase + workflowType), the parser must not require
    // a workflowState wrapper.
    const actions = nextActionsFromResult(
      ok({
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'top-level-mo',
        mergeOrchestrator: { taskId: '099', phase: 'pending' },
      }),
    );
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
    const mo = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(mo?.idempotencyKey).toBe('top-level-mo:merge_orchestrate:099');
  });

  // ─── #1238 ResultDataSchema discriminated union coverage ──────────────────
  //
  // The parser body previously used `Record<string, unknown>` casts and inline
  // `typeof` guards. #1238 replaces that with a Zod union of two shapes plus
  // a fail-closed `safeParse` boundary. These tests pin both shapes plus the
  // malformed → warn-and-[] case.

  describe('#1238 ResultDataSchema discriminated union', () => {
    it('NextActionsFromResult_WorkflowHandlerPayload_ParsesShapeOne', () => {
      // Shape 1 — top-level phase + workflowType (+ optional featureId /
      // mergeOrchestrator). Parses via ShapeOneSchema in the union.
      const parsed = ResultDataSchema.safeParse({
        phase: 'merge-pending',
        workflowType: 'feature',
        featureId: 'shape-one',
        mergeOrchestrator: { taskId: '007', phase: 'pending' },
      });
      expect(parsed.success).toBe(true);

      const actions = nextActionsFromResult(
        ok({
          phase: 'merge-pending',
          workflowType: 'feature',
          featureId: 'shape-one',
          mergeOrchestrator: { taskId: '007', phase: 'pending' },
        }),
      );
      const mo = actions.find((a) => a.verb === 'merge_orchestrate');
      expect(mo).toBeDefined();
      expect(mo?.idempotencyKey).toBe('shape-one:merge_orchestrate:007');
    });

    it('NextActionsFromResult_RehydrationDocument_ParsesShapeTwo', () => {
      // Shape 2 — `{ workflowState: { phase, workflowType, featureId,
      // mergeOrchestrator } }`. Parses via ShapeTwoSchema in the union.
      const parsed = ResultDataSchema.safeParse({
        workflowState: {
          featureId: 'shape-two',
          phase: 'merge-pending',
          workflowType: 'feature',
          mergeOrchestrator: { taskId: '042', phase: 'pending' },
        },
      });
      expect(parsed.success).toBe(true);

      const actions = nextActionsFromResult(
        ok({
          workflowState: {
            featureId: 'shape-two',
            phase: 'merge-pending',
            workflowType: 'feature',
            mergeOrchestrator: { taskId: '042', phase: 'pending' },
          },
        }),
      );
      const mo = actions.find((a) => a.verb === 'merge_orchestrate');
      expect(mo).toBeDefined();
      expect(mo?.idempotencyKey).toBe('shape-two:merge_orchestrate:042');
    });

    describe('NextActionsFromResult_MalformedPayload_FailsClosed', () => {
      let warnSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        warnSpy = vi
          .spyOn(nextActionsLogger, 'warn')
          .mockImplementation(() => undefined as never);
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('returns [] and warns on a payload matching neither shape', () => {
        // Payload that doesn't satisfy ShapeOneSchema (no string phase /
        // workflowType at top level) AND doesn't satisfy ShapeTwoSchema
        // (workflowState missing required featureId string). This must
        // fail-closed: return [] AND log a warning so the malformed payload
        // is surfaced rather than silently swallowed.
        const actions = nextActionsFromResult(
          ok({
            phase: 42, // wrong type for ShapeOne
            workflowState: {
              // missing required `featureId`, wrong type on `phase`
              phase: false,
              workflowType: 'feature',
            },
          }),
        );
        expect(actions).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('NextActionsFromResult_AsymmetricPayload_ShapeOneValidShapeTwoAdvertisedInvalid_FailsClosed', () => {
        // CodeRabbit #1421: union+passthrough let asymmetric malformed
        // payloads slip through. Here shape 1 is *valid* (phase +
        // workflowType are strings) but the payload *advertises* shape 2 by
        // including a `workflowState` key whose value is malformed (phase is
        // boolean, missing required featureId). The pre-fix code would have
        // accepted via the loose union, extracted from shape 1, and silently
        // ignored the bad shape-2 sibling. Per-advertised-shape validation
        // must fail-closed here.
        const actions = nextActionsFromResult(
          ok({
            phase: 'merge-pending',
            workflowType: 'feature',
            workflowState: {
              phase: false,
              workflowType: 'feature',
            },
          }),
        );
        expect(actions).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('NextActionsFromResult_AsymmetricPayload_ShapeTwoValidShapeOneAdvertisedInvalid_FailsClosed', () => {
        // Symmetric: shape 2 valid (workflowState parses), shape 1
        // advertised via top-level `phase`/`workflowType` keys but with
        // wrong types. Per-advertised-shape validation must reject.
        const actions = nextActionsFromResult(
          ok({
            phase: 42,
            workflowType: 99,
            workflowState: {
              featureId: 'x',
              phase: 'ideate',
              workflowType: 'feature',
            },
          }),
        );
        expect(actions).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
      });

      it('NextActionsFromResult_HandleCheckpointShape_PhaseOnly_SilentlyReturnsEmpty', () => {
        // Sentry #1421 rev2 LOW: `handleCheckpoint` returns
        // `{ phase, projectionSequence?, phasePlaybook }` — `phase` but no
        // `workflowType`. With the original `some()` advertise predicate,
        // this would mark shape-1 as advertised, then strict safeParse would
        // fail (missing required `workflowType`), and the helper would emit
        // a misleading "malformed result.data" warning on every legitimate
        // checkpoint call. With the `every()` predicate, partial-key
        // payloads fall through to the silent no-actions path.
        const actions = nextActionsFromResult(
          ok({
            phase: 'delegate',
            projectionSequence: 42,
            phasePlaybook: null,
          }),
        );
        expect(actions).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });

      it('NextActionsFromResult_HandleSetIdempotentShape_PhaseOnly_SilentlyReturnsEmpty', () => {
        // Sentry #1421 rev2 LOW: idempotent branch of `handleSet` returns
        // `{ phase, ... }` without `workflowType`. Same silence-not-warn
        // contract as the checkpoint case above.
        const actions = nextActionsFromResult(ok({ phase: 'review' }));
        expect(actions).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    it('RehydrationMergeOrchestratorSchema_PhaseEnum_MatchesMergeOrchestratorStateSchema', () => {
      // #1421 Sentry pin: the rehydration projection's mergeOrchestrator
      // sub-schema must accept every phase the write-side state schema can
      // persist. Drift here suppresses `merge_orchestrate` during the
      // `executing` window (or any future phase added on the write side).
      const rehydrationShape = RehydrationMergeOrchestratorSchema.shape;
      const writeShape = MergeOrchestratorStateSchema.shape;
      const rehydrationPhases = new Set(
        (rehydrationShape.phase as z.ZodEnum<[string, ...string[]]>).options,
      );
      const writePhases = (
        writeShape.phase as z.ZodEnum<[string, ...string[]]>
      ).options;
      for (const p of writePhases) {
        expect(rehydrationPhases.has(p)).toBe(true);
      }
    });

    it('NextActionsFromResult_RehydrationDocWithExecutingMergePhase_StillSurfacesMergeOrchestrate', () => {
      // Pin: during a merge `executing` window, `handleGet` returns a payload
      // where mergeOrchestrator.phase is 'executing'. The previous schema
      // omitted this enum value so safeParse failed-closed, dropping the
      // `merge_orchestrate` verb. The fix re-aligns the enum.
      const actions = nextActionsFromResult(
        ok({
          workflowState: {
            featureId: 'fid',
            phase: 'merge-pending',
            workflowType: 'feature',
            mergeOrchestrator: { taskId: 'tid', phase: 'executing' },
          },
        }),
      );
      // executing is non-terminal — merge_orchestrate must still surface.
      expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(true);
    });

    it('NextActionsFromResult_NonSuccessResult_ReturnsEmptyArray', () => {
      // Legitimate no-actions path: error envelope. Must NOT log a warning —
      // only malformed-success payloads warn.
      const warnSpy = vi
        .spyOn(nextActionsLogger, 'warn')
        .mockImplementation(() => undefined as never);
      try {
        const result: ToolResult = {
          success: false,
          error: { code: 'X', message: 'no' },
        };
        expect(nextActionsFromResult(result)).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('NextActionsFromResult_NullData_ReturnsEmptyArray', () => {
      // Legitimate no-actions path: success envelope with null/non-object
      // data (describe / list / status actions). Must NOT warn.
      const warnSpy = vi
        .spyOn(nextActionsLogger, 'warn')
        .mockImplementation(() => undefined as never);
      try {
        expect(nextActionsFromResult(ok(null))).toEqual([]);
        expect(nextActionsFromResult(ok(undefined))).toEqual([]);
        expect(nextActionsFromResult(ok('string-payload'))).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('returns [] for unknown workflowType in shape 2', () => {
    const actions = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'x',
          phase: 'ideate',
          workflowType: 'no-such-workflow',
        },
      }),
    );
    expect(actions).toEqual([]);
  });
});

// ─── #1374 cross-boundary pin: reducer output → nextActionsFromResult ────────
//
// Contract source: test/process/saga-merge-detour.test.ts (process tier).
//
// The saga test drives a real MCP server through `task_complete` with
// `result.worktreePath`, then asserts the rehydrate envelope's `next_actions`
// surfaces `merge_orchestrate`. This unit-tier pin reproduces the SAME
// contract one tier earlier — no spawn, no IPC — by composing the
// rehydration reducer (the projection that folds `task.completed{worktreePath}`
// into `phase: merge-pending`) with `nextActionsFromResult` (the helper that
// reads the rehydration document's `workflowState` segment to compute the
// outbound verbs). If the chain breaks at either the reducer's worktree-fold
// or the result-reader's shape-2 extraction, this test fails before the
// process-tier saga does — catching a #1208 / #1374-class regression at the
// unit tier.
//
// Why both tests stay: the saga test pins the cross-process JSON contract
// (MCP envelope shape, stderr/transport plumbing) which this test does not
// cover; this test pins the in-process projection→reader composition which
// the saga can only check end-to-end. They sandwich the chain.
describe('nextActionsFromResult — #1374 cross-boundary pin (reducer ⇒ reader)', () => {
  function makeEvent<T extends Record<string, unknown>>(
    type: string,
    data: T,
    sequence: number,
  ): WorkflowEvent {
    return {
      streamId: 'pin-1374',
      sequence,
      timestamp: '2026-05-15T00:00:00.000Z',
      type,
      schemaVersion: '1.0',
      data,
    } as WorkflowEvent;
  }

  it('NextActions_FromReducerProjectedRehydrationDoc_AfterWorktreeBearingTaskCompleted_SurfacesMergeOrchestrate', () => {
    // GIVEN: a feature workflow folded through `workflow.started` →
    // `workflow.transition(to=delegate)` → `task.assigned` →
    // `task.completed{worktreePath}` — the exact event sequence the saga
    // drives through MCP.
    let doc = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'pin-1374', workflowType: 'feature' },
        0,
      ),
    );
    doc = rehydrationReducer.apply(
      doc,
      makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
    );
    doc = rehydrationReducer.apply(
      doc,
      makeEvent('task.assigned', { taskId: '001', branch: 'feature/pin-1374-001' }, 2),
    );
    doc = rehydrationReducer.apply(
      doc,
      makeEvent(
        'task.completed',
        { taskId: '001', worktreePath: '/tmp/wt/001', worktree: '.worktrees/001' },
        3,
      ),
    );

    // THEN: the reducer has stamped the merge-pending detour on workflowState
    expect(doc.workflowState.phase).toBe('merge-pending');
    expect(doc.workflowState.mergeOrchestrator).toEqual({
      taskId: '001',
      phase: 'pending',
    });

    // WHEN: nextActionsFromResult reads the rehydration document as the
    // composite tool's `result.data` payload (shape 2)
    const actions = nextActionsFromResult({ success: true, data: doc });

    // THEN: merge_orchestrate is surfaced with the canonical idempotency key
    // `<featureId>:merge_orchestrate:<taskId>` — same contract the saga test
    // (test/process/saga-merge-detour.test.ts) asserts on the live envelope.
    const mo = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(mo).toBeDefined();
    expect(mo?.idempotencyKey).toBe('pin-1374:merge_orchestrate:001');
  });

  it('NextActions_FromReducerProjectedDoc_TaskCompletedWithoutWorktree_DoesNotSurfaceMergeOrchestrate', () => {
    // Negative case: no worktree association → reducer leaves phase in
    // `delegate` → nextActionsFromResult must NOT surface merge_orchestrate.
    // Pins the gate so a future regression that fires the detour on bare
    // task.completed events is caught at the unit tier.
    let doc = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'pin-1374-neg', workflowType: 'feature' },
        0,
      ),
    );
    doc = rehydrationReducer.apply(
      doc,
      makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
    );
    doc = rehydrationReducer.apply(
      doc,
      makeEvent('task.completed', { taskId: '001' }, 2),
    );

    expect(doc.workflowState.phase).toBe('delegate');
    expect(doc.workflowState.mergeOrchestrator).toBeUndefined();

    const actions = nextActionsFromResult({ success: true, data: doc });
    expect(actions.some((a) => a.verb === 'merge_orchestrate')).toBe(false);
  });
});

// ─── DR-9 (T-13): the widened envelope actually carries the admission facts ──
//
// The computer-side gate is only worth anything if the SHIPPED envelope path
// supplies the facts. These tests pin that seam end-to-end: a full-state
// handler payload gets gated, and the three payload shapes that are NOT a full
// state (field projection, phase receipt, rehydration document) keep their
// pre-DR-9 topology-only behaviour rather than being silently emptied.
describe('nextActionsFromResult — admission-fact widening (DR-9, T-13)', () => {
  const fullState = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: '1.1',
    featureId: 'feat-dr9',
    phase: 'plan-review',
    workflowType: 'feature',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    artifacts: { plan: 'docs/specs/dr9.md' },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {},
    planReview: { approved: false, gapsFound: false, revisionCount: 0 },
    ...over,
  });

  it('NextActionsFromResult_FullStatePayload_GatesOnAdmission', () => {
    // Unapproved plan review ⇒ admission denies `plan-review → delegate`, so
    // the shipped envelope must not advertise it.
    const denied = nextActionsFromResult(ok(fullState())).map((a) => a.verb);
    expect(denied).not.toContain('delegate');

    // Non-vacuity: the same payload with the approval present publishes it.
    const allowed = nextActionsFromResult(
      ok(fullState({ planReview: { approved: true, gapsFound: false, revisionCount: 0 } })),
    ).map((a) => a.verb);
    expect(allowed).toContain('delegate');
  });

  it('NextActionsFromResult_FieldProjection_IsNotTreatedAsAdmissionFacts', () => {
    // `get` with `fields:['phase','workflowType']` is a deliberately narrowed
    // read, not a state whose artifacts are genuinely absent. Gating on it
    // would empty the affordance list on every projected read.
    const verbs = nextActionsFromResult(
      ok({ phase: 'plan-review', workflowType: 'feature' }),
    ).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  it('NextActionsFromResult_PartialStateMarkers_IsNotTreatedAsAdmissionFacts', () => {
    // All four marker keys are required. A payload carrying only some of them
    // (here: no `reviews`) is still a projection, not a full state.
    const { reviews: _reviews, ...withoutReviews } = fullState();
    const verbs = nextActionsFromResult(ok(withoutReviews)).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  it('NextActionsFromResult_RehydrationDocument_StaysTopologyOnly', () => {
    // Recorded split: the rehydration envelope does not carry `reviews` /
    // `_cleanup` / the event log, so gating it would hide legal moves.
    const verbs = nextActionsFromResult(
      ok({
        workflowState: {
          featureId: 'feat-dr9',
          phase: 'plan-review',
          workflowType: 'feature',
        },
        artifacts: { plan: 'docs/specs/dr9.md' },
        taskProgress: [],
      }),
    ).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  it('NextActionsFromResult_WidenedKeys_DoNotFailTheShapeParse', () => {
    // The widened keys are declared `unknown` so a state-schema evolution (or a
    // null-valued segment) can never turn a usable payload into a "malformed
    // result.data" warning + empty envelope.
    const warn = vi.spyOn(nextActionsLogger, 'warn').mockImplementation(() => undefined);
    try {
      const verbs = nextActionsFromResult(
        ok({
          phase: 'plan-review',
          workflowType: 'feature',
          updatedAt: null,
          artifacts: null,
          tasks: 'not-an-array',
          reviews: 42,
        }),
      ).map((a) => a.verb);
      expect(verbs).toContain('delegate');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
