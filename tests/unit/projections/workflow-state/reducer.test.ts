/**
 * Tests for the `workflow-state@v1` reducer. The import of the workflow-state barrel registers
 * `workflowStateReducer` with `defaultRegistry` at module load, before any test runs.
 */
import { describe, it, expect } from 'vitest';
import type { ProjectionReducer } from '../../../../src/projections/types.js';
import { createRegistry, defaultRegistry } from '../../../../src/projections/registry.js';
import { workflowStateReducer } from '../../../../src/projections/workflow-state/index.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import { assertReducerImmutable } from '../../../../src/projections/testing.js';
import { EventTypes, type WorkflowEvent } from '../../../../src/events/schemas.js';
import { getInitialPhase } from '../../../../src/workflow/state-machine.js';

function ev(type: string, data: Record<string, unknown>, sequence: number): WorkflowEvent {
  return {
    type,
    timestamp: `2026-06-20T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    sequence,
    data,
  } as unknown as WorkflowEvent;
}

function fold(events: WorkflowEvent[]) {
  return events.reduce(
    (view, event) => workflowStateReducer.apply(view, event),
    workflowStateReducer.initial,
  );
}

describe('workflow-state@v1 canonical reducer (#1554-1)', () => {
  it('workflowStateReducer_Registered_HasCanonicalId', () => {
    expect(workflowStateReducer.id).toBe('workflow-state@v1');
    expect(workflowStateReducer.version).toBe(1);
    expect(workflowStateReducer.scope).toBe('stream');
    expect(typeof workflowStateReducer.apply).toBe('function');
  });

  /** The lookup returns the object that the barrel registered, not a copy. */
  it('defaultRegistry_Get_workflowStateV1_ReturnsReducer', () => {
    const found = defaultRegistry.get('workflow-state@v1');
    expect(found).toBe(workflowStateReducer);
    expect(found?.id).toBe('workflow-state@v1');
  });

  it('reducer_BridgesViewProjection_InitialEqualsViewInit', () => {
    expect(workflowStateReducer.initial).toEqual(workflowStateProjection.init());
  });

  it('reducer_ApplyMatchesViewProjectionApply', () => {
    const event = {
      type: 'workflow.started',
      timestamp: '2026-06-20T00:00:00.000Z',
      sequence: 1,
      data: { featureId: 'demo', workflowType: 'feature' },
    } as unknown as WorkflowEvent;
    const viaReducer = workflowStateReducer.apply(workflowStateReducer.initial, event);
    const viaView = workflowStateProjection.apply(workflowStateProjection.init(), event);
    expect(viaReducer).toEqual(viaView);
  });

  it('reducer_IsPure_DoesNotMutateState', () => {
    const events = [
      { type: 'workflow.started', timestamp: '2026-06-20T00:00:00.000Z', sequence: 1, data: { featureId: 'demo', workflowType: 'feature' } },
      { type: 'task.assigned', timestamp: '2026-06-20T00:00:01.000Z', sequence: 2, data: { taskId: 't1', title: 'T1' } },
      { type: 'task.completed', timestamp: '2026-06-20T00:00:02.000Z', sequence: 3, data: { taskId: 't1' } },
    ] as unknown as WorkflowEvent[];
    expect(() => assertReducerImmutable(workflowStateReducer, events)).not.toThrow();
  });
});

describe('projection registry — domain singularity (#1554-1)', () => {
  /** The registry accepts one reducer for each domain, so it rejects a `workflow-state@v2` id. */
  it('register_SecondWorkflowStateDomainReducer_Throws', () => {
    const registry = createRegistry();
    registry.register(workflowStateReducer as ProjectionReducer<unknown, unknown>);
    const imposter: ProjectionReducer<unknown, unknown> = {
      id: 'workflow-state@v2',
      version: 2,
      scope: 'stream',
      initial: {},
      apply: (s) => s,
    };
    expect(() => registry.register(imposter)).toThrow(/workflow-state/);
  });

  /** The exact-id check runs before the domain check, so a duplicate id gives the id message. */
  it('register_ExactDuplicateId_StillThrowsIdMessage', () => {
    const registry = createRegistry();
    const a: ProjectionReducer<unknown, unknown> = {
      id: 'rehydration@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s,
    };
    const b: ProjectionReducer<unknown, unknown> = {
      id: 'rehydration@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s,
    };
    registry.register(a);
    expect(() => registry.register(b)).toThrow(/duplicate projection id: rehydration@v1/);
  });

  it('register_DistinctDomains_Coexist', () => {
    const registry = createRegistry();
    const reducers: ProjectionReducer<unknown, unknown>[] = [
      { id: 'task-store@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s },
      { id: 'merge-orchestrator@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s },
      { id: 'workflow-state@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s },
    ];
    for (const r of reducers) registry.register(r);
    expect(registry.list()).toHaveLength(3);
  });
});

/**
 * The `never` default in the fold makes an `EventTypes` entry with no case a typecheck error.
 * These tests are the runtime companion. They prove that no built-in type reaches the default,
 * which throws.
 */
describe('workflow-state@v1 exhaustiveness (#1554-2)', () => {
  /** Folds one minimal event of each built-in type from the seed. */
  it('fold_EveryBuiltInEventType_DoesNotHitThrowingDefault', () => {
    for (const type of EventTypes) {
      const event = {
        type,
        timestamp: '2026-06-20T00:00:00.000Z',
        sequence: 1,
        data: {},
      } as unknown as WorkflowEvent;
      expect(() => workflowStateReducer.apply(workflowStateReducer.initial, event)).not.toThrow();
    }
  });

  /** No case removes the core keys of the view. */
  it('fold_EveryBuiltInEventType_YieldsValidView', () => {
    for (const type of EventTypes) {
      const event = {
        type,
        timestamp: '2026-06-20T00:00:00.000Z',
        sequence: 1,
        data: {},
      } as unknown as WorkflowEvent;
      const next = workflowStateReducer.apply(workflowStateReducer.initial, event);
      expect(next).toHaveProperty('phase');
      expect(next).toHaveProperty('tasks');
      expect(Array.isArray(next.tasks)).toBe(true);
    }
  });

  /** A custom event type returns the input view by reference, so the fold makes no copy. */
  it('fold_CustomEventType_ReturnsIdentity', () => {
    const seed = workflowStateReducer.initial;
    const custom = {
      type: 'totally.custom.event',
      timestamp: '2026-06-20T00:00:00.000Z',
      sequence: 1,
      data: { anything: true },
    } as unknown as WorkflowEvent;
    expect(workflowStateReducer.apply(seed, custom)).toBe(seed);
  });

  /** `team.spawned` is one of the four event types that append a record to `_events`. */
  it('fold_ObservabilityEvent_AppendsToEventsBreadcrumb', () => {
    const event = {
      type: 'team.spawned',
      timestamp: '2026-06-20T00:00:00.000Z',
      sequence: 1,
      data: { teamSize: 2 },
    } as unknown as WorkflowEvent;
    const next = workflowStateReducer.apply(workflowStateReducer.initial, event);
    expect(next._events).toHaveLength(1);
    expect(next._events[0]).toMatchObject({ type: 'team.spawned' });
  });

  it('fold_ParityWithViewProjection_AcrossAllTypes', () => {
    for (const type of EventTypes) {
      const event = {
        type,
        timestamp: '2026-06-20T00:00:00.000Z',
        sequence: 1,
        data: {},
      } as unknown as WorkflowEvent;
      expect(workflowStateReducer.apply(workflowStateReducer.initial, event))
        .toEqual(workflowStateProjection.apply(workflowStateProjection.init(), event));
    }
  });
});

describe('workflow-state@v1 initial phase from HSM (#1554-3)', () => {
  /** `workflow.started` takes the initial phase of each built-in workflow type from `getInitialPhase`. */
  it('initialPhase_DerivedFromHsm_MatchesGetInitialPhase', () => {
    for (const workflowType of ['feature', 'debug', 'refactor', 'oneshot', 'discovery']) {
      const view = fold([ev('workflow.started', { featureId: 'demo', workflowType }, 1)]);
      expect(view.phase).toBe(getInitialPhase(workflowType));
      expect(view.workflowType).toBe(workflowType);
    }
  });

  /** A `discovery` start must get the `gathering` phase, not the seed phase. */
  it('initialPhase_DiscoveryNoLongerDrifts_IsGathering', () => {
    const view = fold([ev('workflow.started', { featureId: 'd', workflowType: 'discovery' }, 1)]);
    expect(view.phase).toBe('gathering');
  });

  /**
   * `getInitialPhase` throws for an unknown type. The fold keeps the seed phase for a custom type,
   * so a replay of an old log does not fail.
   */
  it('initialPhase_UnknownWorkflowType_FallsBackToSeed_NoThrow', () => {
    let view!: ReturnType<typeof fold>;
    expect(() => {
      view = fold([ev('workflow.started', { featureId: 'x', workflowType: 'bespoke-custom' }, 1)]);
    }).not.toThrow();
    expect(view.phase).toBe(workflowStateReducer.initial.phase);
    expect(view.workflowType).toBe('bespoke-custom');
  });

  /**
   * Pins the fold of a typical feature log. A change to the fold result fails the test until an
   * editor updates the expected value. The reducer fold must also equal the
   * `workflowStateProjection` fold of the same log.
   */
  it('goldenReplay_FeatureLifecycle_ByteEqualSnapshot', () => {
    const view = fold([
      ev('workflow.started', { featureId: 'golden', workflowType: 'feature' }, 1),
      ev('workflow.transition', { to: 'plan' }, 2),
      ev('task.assigned', { taskId: 't1', title: 'T1', branch: 'feat/t1' }, 3),
      ev('task.assigned', { taskId: 't2', title: 'T2' }, 4),
      ev('task.completed', { taskId: 't1' }, 5),
      ev('workflow.transition', { to: 'review' }, 6),
    ]);
    expect({
      featureId: view.featureId,
      workflowType: view.workflowType,
      phase: view.phase,
      tasks: view.tasks,
    }).toEqual({
      featureId: 'golden',
      workflowType: 'feature',
      phase: 'review',
      tasks: [
        { id: 't1', title: 'T1', status: 'complete', branch: 'feat/t1', worktreePath: undefined, completedAt: '2026-06-20T00:00:05.000Z' },
        { id: 't2', title: 'T2', status: 'pending', branch: undefined, worktreePath: undefined },
      ],
    });
    const viaView = [
      ev('workflow.started', { featureId: 'golden', workflowType: 'feature' }, 1),
      ev('workflow.transition', { to: 'plan' }, 2),
      ev('task.assigned', { taskId: 't1', title: 'T1', branch: 'feat/t1' }, 3),
      ev('task.assigned', { taskId: 't2', title: 'T2' }, 4),
      ev('task.completed', { taskId: 't1' }, 5),
      ev('workflow.transition', { to: 'review' }, 6),
    ].reduce((v, e) => workflowStateProjection.apply(v, e), workflowStateProjection.init());
    expect(view).toEqual(viaView);
  });
});
