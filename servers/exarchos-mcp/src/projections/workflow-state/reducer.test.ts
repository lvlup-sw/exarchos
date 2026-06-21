import { describe, it, expect } from 'vitest';
import type { ProjectionReducer } from '../types.js';
import { createRegistry, defaultRegistry } from '../registry.js';
// Import the workflow-state barrel for its module-load-time side effect:
// `defaultRegistry.register(workflowStateReducer)` (DR-1, #1554). Placed at the
// top so registration is reached before any test executes regardless of
// describe ordering — mirrors `projections/registry.test.ts`.
import { workflowStateReducer } from './index.js';
import { workflowStateProjection } from '../../views/workflow-state-projection.js';
import { assertReducerImmutable } from '../testing.js';
import { EventTypes, type WorkflowEvent } from '../../event-store/schemas.js';

describe('workflow-state@v1 canonical reducer (#1554-1)', () => {
  it('workflowStateReducer_Registered_HasCanonicalId', () => {
    // The promoted reducer carries the stable domain id and the
    // ProjectionReducer shape (id/version/scope/initial/apply), registered
    // alongside taskstore/merge-orchestrator/rehydration/next-action.
    expect(workflowStateReducer.id).toBe('workflow-state@v1');
    expect(workflowStateReducer.version).toBe(1);
    // workflow-state folds one feature's stream → 'stream' scope.
    expect(workflowStateReducer.scope).toBe('stream');
    expect(typeof workflowStateReducer.apply).toBe('function');
  });

  it('defaultRegistry_Get_workflowStateV1_ReturnsReducer', () => {
    // The barrel self-registered the reducer at module load (DR-1). Look it up
    // by its canonical id and assert identity (no rewrapping / cloning).
    const found = defaultRegistry.get('workflow-state@v1');
    expect(found).toBe(workflowStateReducer);
    expect(found?.id).toBe('workflow-state@v1');
  });

  it('reducer_BridgesViewProjection_InitialEqualsViewInit', () => {
    // The bridge seed MUST equal the ViewProjection's init() — folding an empty
    // stream yields the same shape the materializer seeds (ViewProjection ↔
    // ProjectionReducer parity).
    expect(workflowStateReducer.initial).toEqual(workflowStateProjection.init());
  });

  it('reducer_ApplyMatchesViewProjectionApply', () => {
    // The canonical fold is the ViewProjection fold — applying a representative
    // event through either path yields an equal view.
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
    // DR-1 purity: folding does not mutate the frozen state argument.
    const events = [
      { type: 'workflow.started', timestamp: '2026-06-20T00:00:00.000Z', sequence: 1, data: { featureId: 'demo', workflowType: 'feature' } },
      { type: 'task.assigned', timestamp: '2026-06-20T00:00:01.000Z', sequence: 2, data: { taskId: 't1', title: 'T1' } },
      { type: 'task.completed', timestamp: '2026-06-20T00:00:02.000Z', sequence: 3, data: { taskId: 't1' } },
    ] as unknown as WorkflowEvent[];
    expect(() => assertReducerImmutable(workflowStateReducer, events)).not.toThrow();
  });
});

describe('projection registry — domain singularity (#1554-1)', () => {
  it('register_SecondWorkflowStateDomainReducer_Throws', () => {
    // Registry singularity: a second reducer claiming the `workflow-state`
    // domain (different id, same domain prefix) is rejected — one canonical
    // left-fold per domain.
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

  it('register_ExactDuplicateId_StillThrowsIdMessage', () => {
    // The pre-existing exact-id guard message is preserved (it fires before the
    // domain check, since same id ⇒ same domain).
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
    // Sanity: distinct domains register side by side (no false positives).
    const registry = createRegistry();
    const reducers: ProjectionReducer<unknown, unknown>[] = [
      { id: 'task-store@v1', version: 1, scope: 'global', initial: {}, apply: (s) => s },
      { id: 'merge-orchestrator@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s },
      { id: 'workflow-state@v1', version: 1, scope: 'stream', initial: {}, apply: (s) => s },
    ];
    for (const r of reducers) registry.register(r);
    expect(registry.list()).toHaveLength(3);
  });
});

describe('workflow-state@v1 exhaustiveness (#1554-2)', () => {
  // Compile-time exhaustiveness is enforced by the `never`-assignment `default`
  // in the canonical fold (`views/workflow-state-projection.ts`): adding an
  // `EventTypes` entry without a case is a `npm run typecheck` error. These
  // tests are the EXECUTABLE companion — they prove the explicit no-op set
  // stays complete at runtime (the throwing default never fires for a built-in).

  it('fold_EveryBuiltInEventType_DoesNotHitThrowingDefault', () => {
    // Fold one minimal event of EVERY built-in type from the seed. Every type
    // must route to an explicit arm (mutating / _events-tracking / no-op); if a
    // future EventTypes entry is left uncased, the `never`-assignment default
    // throws and this test goes red — the runtime backstop to the type check.
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

  it('fold_EveryBuiltInEventType_YieldsValidView', () => {
    // Folding any single built-in event from the seed returns a structurally
    // intact WorkflowStateView (core keys preserved) — no arm corrupts shape.
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

  it('fold_CustomEventType_ReturnsIdentity', () => {
    // A non-built-in (runtime-registered) event type is filtered before the
    // closed-union narrowing and returns the input view by identity — exactly
    // as the pre-#1554 catch-all default did. Reference equality proves no
    // accidental copy / mutation.
    const seed = workflowStateReducer.initial;
    const custom = {
      type: 'totally.custom.event',
      timestamp: '2026-06-20T00:00:00.000Z',
      sequence: 1,
      data: { anything: true },
    } as unknown as WorkflowEvent;
    expect(workflowStateReducer.apply(seed, custom)).toBe(seed);
  });

  it('fold_ObservabilityEvent_AppendsToEventsBreadcrumb', () => {
    // The four _events-tracking observability events still append a breadcrumb
    // (behavior preserved verbatim across the #1554-2 restructure).
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
    // The bridge stays a faithful delegate: reducer.apply ≡ projection.apply for
    // every built-in type (byte-equal fold — #1554 acceptance is byte-equality).
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
