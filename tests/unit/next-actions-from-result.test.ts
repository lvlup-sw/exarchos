/**
 * Unit tests for `nextActionsFromResult`. The helper must recognize two payload shapes:
 *
 * 1. The handler shape of `handleInit`, `handleGet` and `handleSet`, with `phase` and
 *    `workflowType` at the top level.
 * 2. The rehydration document of `handleRehydrate`:
 *    `{ workflowState: { phase, workflowType, featureId, mergeOrchestrator } }`.
 *
 * A reader that ignores shape 2 gives no next actions for a rehydrate envelope in `merge-pending`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { z } from 'zod';
import {
  nextActionsFromResult,
  nextActionsLogger,
  ResultDataSchema,
} from '../../src/next-actions-from-result.js';
import type { ToolResult } from '../../src/format.js';
import { rehydrationReducer } from '../../src/projections/rehydration/reducer.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { RehydrationMergeOrchestratorSchema } from '../../src/projections/rehydration/schema.js';
import { MergeOrchestratorStateSchema } from '../../src/workflow/schemas.js';

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

  /** The feature HSM lists one transition out of `plan`, and its target is `plan-review`. */
  it('extracts shape 1 (handler payload) — phase + workflowType at top level', () => {
    const actions = nextActionsFromResult(
      ok({ phase: 'plan', workflowType: 'feature' }),
    );
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

  /** A rehydrate envelope in `merge-pending` offers its HSM edge back to `delegate`, and never the retired `merge_orchestrate`. */
  it('offers only the delegate return from shape 2 when phase is merge-pending', () => {
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
    expect(actions.map((a) => a.verb)).toEqual(['delegate']);
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

  /** The top-level `phase` and `workflowType` win over the `workflowState` segment. */
  it('prefers shape 1 when both shapes could match', () => {
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

  /**
   * `ResultDataSchema` is a Zod union of the two shapes. A payload that advertises a shape and
   * fails its parse gives `[]` and a warning.
   */
  describe('#1238 ResultDataSchema discriminated union', () => {
    it('NextActionsFromResult_WorkflowHandlerPayload_ParsesShapeOne', () => {
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
      expect(actions.map((a) => a.verb)).toEqual(['delegate']);
    });

    it('NextActionsFromResult_RehydrationDocument_ParsesShapeTwo', () => {
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
      expect(actions.map((a) => a.verb)).toEqual(['delegate']);
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

      /**
       * `workflowState` lacks `featureId` and has a non-string `phase`, so shape 2 fails its
       * parse. The reader must return `[]` and log a warning, not ignore the payload.
       */
      it('returns [] and warns on a payload matching neither shape', () => {
        const actions = nextActionsFromResult(
          ok({
            phase: 42,
            workflowState: {
              phase: false,
              workflowType: 'feature',
            },
          }),
        );
        expect(actions).toEqual([]);
        expect(warnSpy).toHaveBeenCalled();
      });

      /**
       * Shape 1 is valid, but the payload also advertises shape 2 with a malformed
       * `workflowState`. A union parse accepts this payload through shape 1. The reader parses
       * each advertised shape on its own, so it must reject the payload.
       */
      it('NextActionsFromResult_AsymmetricPayload_ShapeOneValidShapeTwoAdvertisedInvalid_FailsClosed', () => {
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

      /** The mirror case: `workflowState` parses, and the top-level keys have wrong types. */
      it('NextActionsFromResult_AsymmetricPayload_ShapeTwoValidShapeOneAdvertisedInvalid_FailsClosed', () => {
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

      /**
       * `handleCheckpoint` returns `phase` with no `workflowType`. A payload advertises shape 1
       * only when it has each discriminator key, so this receipt gives `[]` with no warning.
       */
      it('NextActionsFromResult_HandleCheckpointShape_PhaseOnly_SilentlyReturnsEmpty', () => {
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

      /** The idempotent branch of `handleSet` also returns `phase` with no `workflowType`. */
      it('NextActionsFromResult_HandleSetIdempotentShape_PhaseOnly_SilentlyReturnsEmpty', () => {
        const actions = nextActionsFromResult(ok({ phase: 'review' }));
        expect(actions).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
      });
    });

    /**
     * The rehydration schema must accept each phase that the write-side schema can persist. A
     * missing phase fails the parse and empties `next_actions`.
     */
    it('RehydrationMergeOrchestratorSchema_PhaseEnum_MatchesMergeOrchestratorStateSchema', () => {
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

    /** An old `executing` merge phase still parses, so the envelope keeps its return to `delegate`. */
    it('NextActionsFromResult_RehydrationDocWithExecutingMergePhase_StillOffersTheDelegateReturn', () => {
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
      expect(actions.map((a) => a.verb)).toEqual(['delegate']);
    });

    /** An error envelope is a legitimate no-actions path, so it must not log a warning. */
    it('NextActionsFromResult_NonSuccessResult_ReturnsEmptyArray', () => {
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

    /** A success envelope with null or non-object data is a legitimate no-actions path. */
    it('NextActionsFromResult_NullData_ReturnsEmptyArray', () => {
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

/**
 * These tests compose the rehydration reducer with `nextActionsFromResult`, in process. The reducer
 * folds a `task.completed` event with a `worktreePath` into `phase: merge-pending`. The reader must
 * then offer the return to `delegate` from the `workflowState` segment, and no `merge_orchestrate`.
 *
 * `tests/process/saga-merge-detour.test.ts` pins the same contract through a real MCP server. That
 * test covers the cross-process envelope, and this one covers the composition.
 */
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

  /** The test folds the event sequence that the saga test drives through MCP. */
  it('NextActions_FromReducerProjectedRehydrationDoc_AfterWorktreeBearingTaskCompleted_OffersTheDelegateReturn', () => {
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

    expect(doc.workflowState.phase).toBe('merge-pending');
    expect(doc.workflowState.mergeOrchestrator).toEqual({
      taskId: '001',
      phase: 'pending',
    });

    const actions = nextActionsFromResult({ success: true, data: doc });

    expect(actions.map((a) => a.verb)).toEqual(['delegate']);
  });

  /**
   * With no worktree association, the reducer leaves the phase in `delegate`. The reader must not
   * surface `merge_orchestrate`.
   */
  it('NextActions_FromReducerProjectedDoc_TaskCompletedWithoutWorktree_DoesNotSurfaceMergeOrchestrate', () => {
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

/**
 * The envelope path must supply the admission facts to the computer. Admission gates a full-state
 * handler payload. A field projection, a partial state and a rehydration document are not full
 * states, so they keep the topology-only list.
 */
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

  /**
   * An unapproved plan review makes admission deny `plan-review` to `delegate`. The same payload
   * with the approval publishes the verb, so the omission is not vacuous.
   */
  it('NextActionsFromResult_FullStatePayload_GatesOnAdmission', () => {
    const denied = nextActionsFromResult(ok(fullState())).map((a) => a.verb);
    expect(denied).not.toContain('delegate');

    const allowed = nextActionsFromResult(
      ok(fullState({ planReview: { approved: true, gapsFound: false, revisionCount: 0 } })),
    ).map((a) => a.verb);
    expect(allowed).toContain('delegate');
  });

  /**
   * A `get` with `fields` is a narrowed read, not a state with absent artifacts. A gate on it
   * empties the list for each projected read.
   */
  it('NextActionsFromResult_FieldProjection_IsNotTreatedAsAdmissionFacts', () => {
    const verbs = nextActionsFromResult(
      ok({ phase: 'plan-review', workflowType: 'feature' }),
    ).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  /**
   * The reader requires each of the four marker keys. A payload with no `reviews` is a projection.
   */
  it('NextActionsFromResult_PartialStateMarkers_IsNotTreatedAsAdmissionFacts', () => {
    const { reviews: _reviews, ...withoutReviews } = fullState();
    const verbs = nextActionsFromResult(ok(withoutReviews)).map((a) => a.verb);
    expect(verbs).toContain('delegate');
  });

  /**
   * The rehydration envelope has no `reviews` and no event log, so a gate on it hides legal moves.
   */
  it('NextActionsFromResult_RehydrationDocument_StaysTopologyOnly', () => {
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

  /**
   * The schema declares the widened keys as `unknown`. A null or wrong-typed segment must not
   * cause a warning and an empty envelope.
   */
  it('NextActionsFromResult_WidenedKeys_DoNotFailTheShapeParse', () => {
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
