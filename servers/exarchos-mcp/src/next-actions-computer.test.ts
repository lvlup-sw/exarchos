import { describe, it, expect } from 'vitest';
import { computeNextActions } from './next-actions-computer.js';
import { NextAction } from './next-action.js';
import { getHSMDefinition } from './workflow/state-machine.js';

describe('computeNextActions (T040, DR-8)', () => {
  it('NextActions_Given_PlanPhase_Then_IncludesDelegateTransition', () => {
    // The feature HSM goes plan-review → delegate, which is the canonical
    // "plan → delegate" transition in the feature workflow topology.
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions.length).toBeGreaterThan(0);

    // Every element validates against the NextAction Zod schema.
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }

    // At least one action corresponds to the plan-review → delegate transition.
    const hasDelegate = actions.some(
      (a) =>
        a.verb === 'delegate' ||
        a.validTargets?.includes('delegate') === true,
    );
    expect(hasDelegate).toBe(true);
  });

  it('NextActions_UnknownPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'not-a-real-phase', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });

  it('NextActions_MissingPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });
});
