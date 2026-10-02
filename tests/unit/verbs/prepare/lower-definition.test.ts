// These tests lower the built-in state machines into the published kernel
// definition. The expected steps and transitions come from the live machine. A
// list of steps typed into this file does not change when the machine gains a
// phase, so it cannot detect the new phase.
//
// @oracle-sources: ../../../../src/verbs/prepare/lower-definition.ts, the live state machine states and transitions read through getHSMDefinition and the published kernel definition schema

import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleAuthorityV1Schema } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { lowerBuiltInDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { getHSMDefinition, listWorkflowTypes } from '../../../../src/workflow/state-machine.js';

const BUILT_INS = ['feature', 'debug', 'refactor', 'oneshot', 'discovery'];

describe('built-in definitions lowered into the kernel', () => {
  /** Each type in `BUILT_INS` must be a workflow type that the state machine registers. */
  it('LowerDefinition_TheBuiltInRoster_IsTheMachinesOwn', () => {
    const registered = listWorkflowTypes().workflowTypes.map((t) => t.name);
    for (const type of BUILT_INS) expect(registered).toContain(type);
  });

  it.each(BUILT_INS)('LowerDefinition_%s_SatisfiesThePublishedKernel', (type) => {
    const lowered = lowerBuiltInDefinition(type);
    expect(lowered).toBeDefined();
    expect(WorkflowDefinitionV1Schema.safeParse(lowered?.definition).success).toBe(true);
  });

  it.each(BUILT_INS)('LowerDefinition_%s_HasOneStepPerNonCompoundState', (type) => {
    const hsm = getHSMDefinition(type);
    const expected = Object.values(hsm.states)
      .filter((state) => state.type !== 'compound')
      .map((state) => state.id)
      .sort();
    const steps = (lowerBuiltInDefinition(type)?.definition.steps ?? []).map((step) => step.stepId).sort();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps).toEqual(expected);
  });

  it.each(BUILT_INS)('LowerDefinition_%s_EveryTransitionJoinsTwoSteps', (type) => {
    const definition = lowerBuiltInDefinition(type)?.definition;
    const stepIds = new Set((definition?.steps ?? []).map((step) => step.stepId));
    const transitions = definition?.transitions ?? [];
    expect(transitions.length).toBeGreaterThan(0);
    for (const transition of transitions) {
      expect(stepIds, transition.transitionId).toContain(transition.fromStepId);
      expect(stepIds, transition.transitionId).toContain(transition.toStepId);
    }
  });

  /**
   * A transition between two non-compound states must arrive unchanged. The
   * lowering expands a transition that touches a compound state, and the
   * endpoint test above covers it.
   */
  it.each(BUILT_INS)('LowerDefinition_%s_CarriesEveryMachineTransitionBetweenLeaves', (type) => {
    const hsm = getHSMDefinition(type);
    const leaf = (id: string): boolean => hsm.states[id]?.type !== 'compound';
    const lowered = new Set(
      (lowerBuiltInDefinition(type)?.definition.transitions ?? []).map((t) => `${t.fromStepId}->${t.toStepId}`),
    );
    for (const transition of hsm.transitions.filter((t) => leaf(t.from) && leaf(t.to))) {
      expect(lowered).toContain(`${transition.from}->${transition.to}`);
    }
  });

  it('LowerDefinition_Feature_EntersAtItsInitialPhaseAndFlattensImplementation', () => {
    const definition = lowerBuiltInDefinition('feature')?.definition;
    expect(definition?.entryStepId).toBe('plan');
    const stepIds = (definition?.steps ?? []).map((step) => step.stepId);
    expect(stepIds).toContain('delegate');
    expect(stepIds).not.toContain('implementation');
  });

  it('LowerDefinition_TheDigest_IsStableAndMovesWithTheTopology', () => {
    const first = lowerBuiltInDefinition('feature');
    const second = lowerBuiltInDefinition('feature');
    expect(first?.definitionVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.definitionVersion).toBe(first?.definitionVersion);
    if (first === undefined) return;
    const oneTransitionFewer = {
      ...first.definition,
      transitions: first.definition.transitions.slice(1),
    };
    expect(contentDigest(oneTransitionFewer)).not.toBe(first.definitionVersion);
  });

  /**
   * With no catalog registered, the authority still passes the capsule
   * authority schema. A repository with no invariants still gets a capsule
   * that settle can judge.
   */
  it.each(BUILT_INS)('LowerDefinition_%s_CarriesAnAuthorityACapsuleCanSettleAgainst', (type) => {
    const authority = lowerBuiltInDefinition(type)?.definition.authority;
    expect(ExarchosCapsuleAuthorityV1Schema.safeParse(authority).success).toBe(true);
  });

  it('LowerDefinition_ACustomWorkflowType_IsNotLowered', () => {
    expect(lowerBuiltInDefinition('security-audit')).toBeUndefined();
  });
});
