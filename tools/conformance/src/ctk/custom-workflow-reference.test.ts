// ─── P07-04 exit-proof (a)/(b) — custom-workflow reference validation ────────
//
// Discriminating tests for `validateWorkflowReferences`:
//   (a) an INVALID custom workflow — a dangling phase / guard / parent reference
//       — fails with a diagnostic that NAMES the reference and where it came
//       from; and
//   (b) a VALID custom workflow (including one that inherits phases from a
//       resolvable parent) passes with zero diagnostics.
//
// The suite pins each dangling-reference class independently and asserts the
// diagnostic's `reference` / `workflow` / `location` fields, so a validator that
// merely returns `ok: false` without localizing the fault would fail here.

import { describe, it, expect } from 'vitest';

import type { WorkflowDefinition } from '../../../../src/config/define.js';
import {
  validateWorkflowReferences,
  type WorkflowReferenceDiagnostic,
  type WorkflowReferenceDiagnosticCode,
} from './__fixtures__/workflow-reference-validator.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

// ─── (b) valid references pass ───────────────────────────────────────────────

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

  it('TransitionReferencingInheritedPhase_ResolvesViaKnownParentPhases_Ok', () => {
    // `to: 'review'` is NOT in the child's own phases; it is inherited from the
    // built-in parent whose phase set is supplied. With the parent phases known,
    // the reference resolves and does NOT dangle.
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

  it('UnknownParentPhases_DoesNotFalselyFlagInheritedPhaseReference', () => {
    // The parent type is accepted (known type) but its phases are NOT supplied,
    // so a `to` that we cannot see must NOT be reported as dangling.
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

// ─── (a) invalid references fail with actionable diagnostics ─────────────────

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

    // Deterministic ordering — same input, same diagnostic sequence.
    expect(second.diagnostics).toEqual(first.diagnostics);

    const codes = first.diagnostics.map((d) => d.code);
    expect(codes).toContain('DANGLING_EXTENDS');
    expect(codes).toContain('DANGLING_INITIAL_PHASE');
    expect(codes).toContain('DANGLING_TRANSITION_TO');
    expect(codes).toContain('DANGLING_TRANSITION_FROM');
    expect(codes).toContain('DANGLING_GUARD');
    // Every diagnostic localizes to the offending workflow.
    expect(first.diagnostics.every((d) => d.workflow === 'broken')).toBe(true);
  });

  it('EmptyConfig_IsVacuouslyOk', () => {
    expect(validateWorkflowReferences({})).toEqual({ ok: true, diagnostics: [] });
  });
});
