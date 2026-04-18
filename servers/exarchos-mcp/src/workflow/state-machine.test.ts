import { describe, it, expect } from 'vitest';
import {
  serializeTopology,
  listWorkflowTypes,
  getHSMDefinition,
  getInitialPhase,
  isBuiltInWorkflowType,
  executeTransition,
} from './state-machine.js';
import type { SerializedTopology, WorkflowTypeSummary } from './state-machine.js';

describe('serializeTopology', () => {
  it('SerializeTopology_FeatureWorkflow_ReturnsStatesAndTransitions', () => {
    const result: SerializedTopology = serializeTopology('feature');

    expect(result.workflowType).toBe('feature');
    expect(result.initialPhase).toBe('ideate');

    // States should have id and type
    expect(result.states['ideate']).toBeDefined();
    expect(result.states['ideate'].id).toBe('ideate');
    expect(result.states['ideate'].type).toBe('atomic');

    expect(result.states['completed']).toBeDefined();
    expect(result.states['completed'].type).toBe('final');

    expect(result.states['implementation']).toBeDefined();
    expect(result.states['implementation'].type).toBe('compound');

    // Transitions should have from and to
    expect(result.transitions.length).toBeGreaterThan(0);
    const ideaToPlan = result.transitions.find(
      (t) => t.from === 'ideate' && t.to === 'plan',
    );
    expect(ideaToPlan).toBeDefined();
    expect(ideaToPlan!.from).toBe('ideate');
    expect(ideaToPlan!.to).toBe('plan');
  });

  it('SerializeTopology_RefactorWorkflow_IncludesTracks', () => {
    const result: SerializedTopology = serializeTopology('refactor');

    // Tracks should be derived from compound states
    expect(result.tracks).toBeDefined();
    expect(Object.keys(result.tracks).length).toBeGreaterThan(0);

    // Polish track should contain its child states
    expect(result.tracks['polish-track']).toBeDefined();
    expect(result.tracks['polish-track']).toContain('polish-implement');
    expect(result.tracks['polish-track']).toContain('polish-validate');
    expect(result.tracks['polish-track']).toContain('polish-update-docs');

    // Overhaul track should contain its child states
    expect(result.tracks['overhaul-track']).toBeDefined();
    expect(result.tracks['overhaul-track']).toContain('overhaul-plan');
    expect(result.tracks['overhaul-track']).toContain('overhaul-delegate');
    expect(result.tracks['overhaul-track']).toContain('overhaul-review');
    expect(result.tracks['overhaul-track']).toContain('overhaul-update-docs');
  });

  it('SerializeTopology_TransitionGuards_IncludeIdAndDescription', () => {
    const result: SerializedTopology = serializeTopology('feature');

    // Find a guarded transition (ideate -> plan has designArtifactExists guard)
    const ideaToPlan = result.transitions.find(
      (t) => t.from === 'ideate' && t.to === 'plan',
    );
    expect(ideaToPlan).toBeDefined();
    expect(ideaToPlan!.guard).toBeDefined();
    expect(ideaToPlan!.guard!.id).toBe('design-artifact-exists');
    expect(ideaToPlan!.guard!.description).toBe('Design artifact must exist');

    // Guard should NOT have an evaluate function (JSON-serializable)
    expect((ideaToPlan!.guard as Record<string, unknown>)['evaluate']).toBeUndefined();
  });

  it('SerializeTopology_CompoundStates_IncludeParentAndInitial', () => {
    const result: SerializedTopology = serializeTopology('feature');

    // The compound state should have initial and maxFixCycles
    const implementation = result.states['implementation'];
    expect(implementation).toBeDefined();
    expect(implementation.type).toBe('compound');
    expect(implementation.initial).toBe('delegate');
    expect(implementation.maxFixCycles).toBe(3);

    // Child states should have parent
    const delegate = result.states['delegate'];
    expect(delegate).toBeDefined();
    expect(delegate.parent).toBe('implementation');

    const review = result.states['review'];
    expect(review).toBeDefined();
    expect(review.parent).toBe('implementation');

    // Compound state should include onEntry and onExit
    expect(implementation.onEntry).toEqual(['log']);
    expect(implementation.onExit).toEqual(['log']);
  });

  it('SerializeTopology_UnknownWorkflowType_Throws', () => {
    expect(() => serializeTopology('nonexistent')).toThrow(
      'Unknown workflow type: nonexistent',
    );
  });

  it('SerializeTopology_TransitionsIncludeFixCycleAndEffects', () => {
    const result: SerializedTopology = serializeTopology('feature');

    // review -> delegate is a fix cycle
    const reviewToDelegate = result.transitions.find(
      (t) => t.from === 'review' && t.to === 'delegate',
    );
    expect(reviewToDelegate).toBeDefined();
    expect(reviewToDelegate!.isFixCycle).toBe(true);
    expect(reviewToDelegate!.effects).toEqual(['increment-fix-cycle']);
  });
});

describe('listWorkflowTypes', () => {
  it('ListWorkflowTypes_ReturnsAllRegisteredTypes', () => {
    const result: WorkflowTypeSummary = listWorkflowTypes();

    expect(result.workflowTypes).toBeDefined();
    expect(result.workflowTypes.length).toBeGreaterThanOrEqual(3);

    // Should include feature, debug, and refactor
    const names = result.workflowTypes.map((wt) => wt.name);
    expect(names).toContain('feature');
    expect(names).toContain('debug');
    expect(names).toContain('refactor');

    // Each entry should have initialPhase, phaseCount, trackCount
    const feature = result.workflowTypes.find((wt) => wt.name === 'feature');
    expect(feature).toBeDefined();
    expect(feature!.initialPhase).toBe('ideate');
    expect(feature!.phaseCount).toBeGreaterThan(0);
    expect(feature!.trackCount).toBeGreaterThanOrEqual(0);

    // Debug has two tracks (thorough-track, hotfix-track)
    const debug = result.workflowTypes.find((wt) => wt.name === 'debug');
    expect(debug).toBeDefined();
    expect(debug!.trackCount).toBe(2);

    // Refactor has two tracks (polish-track, overhaul-track)
    const refactor = result.workflowTypes.find((wt) => wt.name === 'refactor');
    expect(refactor).toBeDefined();
    expect(refactor!.trackCount).toBe(2);
  });
});

// ─── Discovery Workflow Tests (#1080) ──────────────────────────────────────

describe('Discovery workflow', () => {
  it('getHSMDefinition_Discovery_ReturnsValidDefinition', () => {
    const hsm = getHSMDefinition('discovery');
    expect(hsm.id).toBe('discovery');
    expect(Object.keys(hsm.states)).toContain('gathering');
    expect(Object.keys(hsm.states)).toContain('synthesizing');
    expect(Object.keys(hsm.states)).toContain('completed');
    expect(Object.keys(hsm.states)).toContain('cancelled');
  });

  it('getInitialPhase_Discovery_ReturnsGathering', () => {
    expect(getInitialPhase('discovery')).toBe('gathering');
  });

  it('isBuiltInWorkflowType_Discovery_ReturnsTrue', () => {
    expect(isBuiltInWorkflowType('discovery')).toBe(true);
  });

  it('executeTransition_Discovery_GatheringToSynthesizing_PassesWithSources', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: { sources: ['a.md'] }, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('synthesizing');
  });

  it('executeTransition_Discovery_GatheringToSynthesizing_FailsWithoutSources', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', artifacts: {}, _events: [] };
    const result = executeTransition(hsm, state, 'synthesizing');
    expect(result.success).toBe(false);
  });

  it('executeTransition_Discovery_SynthesizingToCompleted_PassesWithReport', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'synthesizing', artifacts: { report: 'docs/report.md' }, _events: [] };
    const result = executeTransition(hsm, state, 'completed');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('completed');
  });

  it('executeTransition_Discovery_CancelFromGathering_Succeeds', () => {
    const hsm = getHSMDefinition('discovery');
    const state = { phase: 'gathering', _events: [] };
    const result = executeTransition(hsm, state, 'cancelled');
    expect(result.success).toBe(true);
    expect(result.newPhase).toBe('cancelled');
  });
});
