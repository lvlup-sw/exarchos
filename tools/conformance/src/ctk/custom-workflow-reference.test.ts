/**
 * Tests for `validateWorkflowReferences`. An invalid custom workflow, with a dangling phase, guard
 * or parent reference, fails with a diagnostic that names the reference and its origin. A valid
 * custom workflow passes with zero diagnostics, also when it inherits phases from a parent.
 *
 * Each dangling-reference class has its own case. Each case asserts the `reference`, `workflow`
 * and `location` fields, so a validator that returns `ok: false` without the location fails.
 */
import { describe, it, expect } from 'vitest';

import type { WorkflowDefinition } from '../../../../src/config/define.js';
import {
  validateWorkflowReferences,
  type WorkflowReferenceDiagnostic,
  type WorkflowReferenceDiagnosticCode,
} from './__fixtures__/workflow-reference-validator.js';

/** A fully valid, self-contained custom workflow with every reference resolved. */
const validWorkflow: WorkflowDefinition = {
  phases: ['intake', 'work', 'done'],
  initialPhase: 'intake',
  transitions: [
    { from: 'intake', to: 'work', event: 'begin' },
    { from: 'work', to: 'done', event: 'finish', guard: 'work-complete' },
  ],
  guards: {
    'work-complete': { command: 'echo done' },
  },
};

function only(
  diagnostics: readonly WorkflowReferenceDiagnostic[],
  code: WorkflowReferenceDiagnosticCode,
): WorkflowReferenceDiagnostic {
  const matches = diagnostics.filter((d) => d.code === code);
  expect(matches, `expected exactly one ${code} diagnostic`).toHaveLength(1);
  return matches[0]!;
}

describe('validateWorkflowReferences — valid references pass', () => {
  it('ValidWorkflow_AllReferencesResolve_OkWithNoDiagnostics', () => {
    const report = validateWorkflowReferences({ custom: validWorkflow });
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
  });

  it('ValidExtendsBuiltIn_ResolvesParent_Ok', () => {
    const report = validateWorkflowReferences({
      hardened: { ...validWorkflow, extends: 'feature' },
    });
    expect(report.ok).toBe(true);
  });

  /**
   * `to: 'review'` is not a phase of the child. It comes from the parent, whose phases are
   * supplied, so the reference resolves.
   */
  it('TransitionReferencingInheritedPhase_ResolvesViaKnownParentPhases_Ok', () => {
    const child: WorkflowDefinition = {
      extends: 'feature',
      phases: ['intake'],
      initialPhase: 'intake',
      transitions: [{ from: 'intake', to: 'review', event: 'handoff' }],
    };
    const report = validateWorkflowReferences(
      { child },
      { knownWorkflowPhases: { feature: ['plan', 'review', 'synthesize'] } },
    );
    expect(report.ok).toBe(true);
  });

  it('TransitionReferencingSiblingParentPhase_ResolvesFromConfig_Ok', () => {
    const parent: WorkflowDefinition = {
      phases: ['root-a', 'root-b'],
      initialPhase: 'root-a',
      transitions: [{ from: 'root-a', to: 'root-b', event: 'e' }],
    };
    const child: WorkflowDefinition = {
      extends: 'parent',
      phases: ['leaf'],
      initialPhase: 'leaf',
      transitions: [{ from: 'leaf', to: 'root-b', event: 'up' }],
    };
    const report = validateWorkflowReferences({ parent, child });
    expect(report.ok).toBe(true);
  });

  /**
   * The parent type is known, but its phases are not supplied. So a `to` that the validator cannot
   * see is not reported as dangling.
   */
  it('UnknownParentPhases_DoesNotFalselyFlagInheritedPhaseReference', () => {
    const child: WorkflowDefinition = {
      extends: 'feature',
      phases: ['intake'],
      initialPhase: 'intake',
      transitions: [{ from: 'intake', to: 'some-inherited-phase', event: 'go' }],
    };
    const report = validateWorkflowReferences({ child });
    expect(report.ok).toBe(true);
  });
});

describe('validateWorkflowReferences — dangling references fail with diagnostics', () => {
  it('DanglingTransitionTo_NamesReferenceAndOrigin', () => {
    const broken: WorkflowDefinition = {
      phases: ['intake', 'work'],
      initialPhase: 'intake',
      transitions: [
        { from: 'intake', to: 'work', event: 'begin' },
        { from: 'work', to: 'nonexistent', event: 'finish' },
      ],
    };
    const report = validateWorkflowReferences({ broken });
    expect(report.ok).toBe(false);

    const d = only(report.diagnostics, 'DANGLING_TRANSITION_TO');
    expect(d.workflow).toBe('broken');
    expect(d.reference).toBe('nonexistent');
    expect(d.location).toBe('transitions[1].to');
    expect(d.message).toContain("'nonexistent'");
    expect(d.message).toContain("'broken'");
  });

  it('DanglingTransitionFrom_NamesReferenceAndOrigin', () => {
    const broken: WorkflowDefinition = {
      phases: ['a', 'b'],
      initialPhase: 'a',
      transitions: [{ from: 'ghost', to: 'b', event: 'x' }],
    };
    const d = only(
      validateWorkflowReferences({ broken }).diagnostics,
      'DANGLING_TRANSITION_FROM',
    );
    expect(d.reference).toBe('ghost');
    expect(d.location).toBe('transitions[0].from');
  });

  it('DanglingGuard_NamesGuardAndTransition', () => {
    const broken: WorkflowDefinition = {
      phases: ['a', 'b'],
      initialPhase: 'a',
      transitions: [{ from: 'a', to: 'b', event: 'x', guard: 'no-such-guard' }],
      guards: { 'other-guard': { command: 'true' } },
    };
    const d = only(
      validateWorkflowReferences({ broken }).diagnostics,
      'DANGLING_GUARD',
    );
    expect(d.reference).toBe('no-such-guard');
    expect(d.location).toBe('transitions[0].guard');
    expect(d.message).toContain('guards');
  });

  it('DanglingExtends_NamesUnknownParent', () => {
    const broken: WorkflowDefinition = {
      extends: 'not-a-real-workflow',
      phases: ['a'],
      initialPhase: 'a',
      transitions: [],
    };
    const d = only(
      validateWorkflowReferences({ broken }).diagnostics,
      'DANGLING_EXTENDS',
    );
    expect(d.reference).toBe('not-a-real-workflow');
    expect(d.location).toBe('extends');
  });

  it('DanglingInitialPhase_NamesMissingInitial', () => {
    const broken: WorkflowDefinition = {
      phases: ['a', 'b'],
      initialPhase: 'zzz',
      transitions: [],
    };
    const d = only(
      validateWorkflowReferences({ broken }).diagnostics,
      'DANGLING_INITIAL_PHASE',
    );
    expect(d.reference).toBe('zzz');
    expect(d.location).toBe('initialPhase');
  });

  it('DuplicatePhase_IsReported', () => {
    const broken: WorkflowDefinition = {
      phases: ['a', 'b', 'a'],
      initialPhase: 'a',
      transitions: [],
    };
    const d = only(
      validateWorkflowReferences({ broken }).diagnostics,
      'DUPLICATE_PHASE',
    );
    expect(d.reference).toBe('a');
  });

  it('EmptyPhases_IsReported', () => {
    const broken: WorkflowDefinition = {
      phases: [],
      initialPhase: 'a',
      transitions: [],
    };
    const report = validateWorkflowReferences({ broken });
    expect(report.diagnostics.some((d) => d.code === 'EMPTY_PHASES')).toBe(true);
  });

  /** The same input gives the same diagnostic order, and each diagnostic names the workflow. */
  it('MultipleFaults_AreAllReported_InDeterministicOrder', () => {
    const broken: WorkflowDefinition = {
      extends: 'ghost-parent',
      phases: ['a'],
      initialPhase: 'missing',
      transitions: [
        { from: 'a', to: 'nowhere', event: 'x' },
        { from: 'also-missing', to: 'a', event: 'y', guard: 'undeclared' },
      ],
    };
    const first = validateWorkflowReferences({ broken });
    const second = validateWorkflowReferences({ broken });

    expect(second.diagnostics).toEqual(first.diagnostics);

    const codes = first.diagnostics.map((d) => d.code);
    expect(codes).toContain('DANGLING_EXTENDS');
    expect(codes).toContain('DANGLING_INITIAL_PHASE');
    expect(codes).toContain('DANGLING_TRANSITION_TO');
    expect(codes).toContain('DANGLING_TRANSITION_FROM');
    expect(codes).toContain('DANGLING_GUARD');
    expect(first.diagnostics.every((d) => d.workflow === 'broken')).toBe(true);
  });

  it('EmptyConfig_IsVacuouslyOk', () => {
    expect(validateWorkflowReferences({})).toEqual({ ok: true, diagnostics: [] });
  });
});
