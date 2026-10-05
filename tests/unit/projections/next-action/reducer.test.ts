/**
 * Tests for the `next-action@v1` projection reducer.
 * The projection comes from the current workflow state and the HSM topology, not from a fold of events.
 * So `apply` is the identity function, and `derive(state, hsm)` delegates to `computeNextActions`.
 * The reducer keeps the `ProjectionReducer` shape, so the registry owns its identity and version.
 * This file imports the `index.ts` barrel only for its registration side effect.
 */
import { describe, it, expect } from 'vitest';
import { nextActionReducer } from '../../../../src/projections/next-action/reducer.js';
import { computeNextActions } from '../../../../src/next-actions-computer.js';
import { getHSMDefinition } from '../../../../src/workflow/state-machine.js';
import { defaultRegistry } from '../../../../src/projections/registry.js';
import '../../../../src/projections/next-action/index.js';

describe('next-action reducer — parity with T040 computeNextActions (T060, DR-16)', () => {
  /** `plan-review` has outbound transitions in the feature HSM. `derive` must return exactly what `computeNextActions` returns. */
  it('NextActionReducer_SameOutputAsLegacyInline', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    const viaReducer = nextActionReducer.derive(state, hsm);

    const viaComputer = computeNextActions(state, hsm);
    expect(viaReducer).toEqual(viaComputer);
  });

  it('NextActionReducer_UnknownPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'not-a-real-phase', workflowType: 'feature' };

    const viaReducer = nextActionReducer.derive(state, hsm);

    expect(viaReducer).toEqual([]);
  });

  /** `apply` must return the same state reference, because the projection is not an event fold. */
  it('NextActionReducer_Apply_IsIdentity', () => {
    const state = nextActionReducer.initial;
    const event = {
      streamId: 'wf-test',
      sequence: 1,
      timestamp: '2026-04-24T00:00:00.000Z',
      type: 'workflow.started',
      schemaVersion: '1.0',
      data: { featureId: 'x', workflowType: 'feature' },
    } as Parameters<typeof nextActionReducer.apply>[1];

    const next = nextActionReducer.apply(state, event);

    expect(next).toBe(state);
  });
});

describe('projection registry — next-action barrel registration (T060, DR-17)', () => {
  /** The barrel import registers the reducer at module load. The registry must return that same instance. */
  it('Registry_Get_nextActionV1_ReturnsReducer', () => {
    const found = defaultRegistry.get('next-action@v1');
    expect(found).toBe(nextActionReducer);
    expect(found?.id).toBe('next-action@v1');
    expect(found?.version).toBe(1);
  });
});
