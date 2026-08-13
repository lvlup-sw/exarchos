/**
 * Tests for the `next-action@v1` projection reducer (T060, DR-16, DR-17).
 *
 * The `next-action` projection is a **state-derived** projection: it computes
 * `NextAction[]` from the current `WorkflowState` + HSM topology rather than
 * folding an event stream. To satisfy the `ProjectionReducer<S, E>` purity
 * contract while honoring that nature, the reducer:
 *
 *   - ships `apply` as the identity function over the event stream (events do
 *     not change the projected value — the projection is a function of the
 *     current state + HSM, both provided by the caller via `derive`), and
 *   - exposes a `derive(state, hsm)` method that delegates to T040's pure
 *     `computeNextActions`.
 *
 * This keeps the reducer registrable under DR-1 (so the registry remains the
 * single source of truth for projection identity / versioning) while not
 * pretending the projection is an event fold.
 */
import { describe, it, expect } from 'vitest';
import { nextActionReducer } from './reducer.js';
import { computeNextActions } from '../../next-actions-computer.js';
import { getHSMDefinition } from '../../workflow/state-machine.js';
import { defaultRegistry } from '../registry.js';
// Import the barrel for its module-load-time registration side effect
// (DR-1 convention — see rehydration/index.ts for the prior art).
import './index.js';

describe('next-action reducer — parity with T040 computeNextActions (T060, DR-16)', () => {
  it('NextActionReducer_SameOutputAsLegacyInline', () => {
    // GIVEN: a workflow state with phase + workflowType set to a phase that
    //   has outbound transitions in the feature HSM.
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    // WHEN: we derive NextAction[] via the reducer.
    const viaReducer = nextActionReducer.derive(state, hsm);

    // THEN: the output equals what T040's pure computer returns for the same
    //   inputs — byte-for-byte parity is the migration contract.
    const viaComputer = computeNextActions(state, hsm);
    expect(viaReducer).toEqual(viaComputer);
  });

  it('NextActionReducer_UnknownPhase_ReturnsEmpty', () => {
    // GIVEN: a phase not present in the HSM.
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'not-a-real-phase', workflowType: 'feature' };

    // WHEN: we derive.
    const viaReducer = nextActionReducer.derive(state, hsm);

    // THEN: empty, mirroring computeNextActions.
    expect(viaReducer).toEqual([]);
  });

  it('NextActionReducer_Apply_IsIdentity', () => {
    // GIVEN: an arbitrary initial state value and an arbitrary event.
    const state = nextActionReducer.initial;
    const event = {
      streamId: 'wf-test',
      sequence: 1,
      timestamp: '2026-04-24T00:00:00.000Z',
      type: 'workflow.started',
      schemaVersion: '1.0',
      data: { featureId: 'x', workflowType: 'feature' },
    } as Parameters<typeof nextActionReducer.apply>[1];

    // WHEN: we fold the event.
    const next = nextActionReducer.apply(state, event);

    // THEN: the reducer is a state-derived projection, not an event fold —
    //   `apply` MUST return the input state unchanged (reference identity).
    expect(next).toBe(state);
  });
});

describe('projection registry — next-action barrel registration (T060, DR-17)', () => {
  it('Registry_Get_nextActionV1_ReturnsReducer', () => {
    // GIVEN: the barrel has been imported above, which MUST have triggered
    //   `defaultRegistry.register(nextActionReducer)` at module load.
    // WHEN: we look up the reducer by its canonical id.
    const found = defaultRegistry.get('next-action@v1');
    // THEN: we get back the exact reducer instance, preserving id + version.
    expect(found).toBe(nextActionReducer);
    expect(found?.id).toBe('next-action@v1');
    expect(found?.version).toBe(1);
  });
});
