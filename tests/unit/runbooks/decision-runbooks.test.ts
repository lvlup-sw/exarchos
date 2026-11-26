import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS } from '../../../src/runbooks/definitions.js';
import type { RunbookStep } from '../../../src/runbooks/types.js';

const DECISION_RUNBOOK_IDS = [
  'triage-decision',
  'investigation-decision',
  'scope-decision',
  'dispatch-decision',
  'review-escalation',
  'shepherd-escalation',
  'task-classification',
  'review-strategy',
  'design-refinement',
  'plan-coverage-check',
  'phase-compression',
];

describe('Decision runbooks', () => {
  it('decisionRunbooks_AllRegistered', () => {
    const registeredIds = ALL_RUNBOOKS.map(r => r.id);
    for (const id of DECISION_RUNBOOK_IDS) {
      expect(registeredIds).toContain(id);
    }
  });

  /** The machine has no merge substate, so no runbook names the `merge-pending` phase or the retired `merge-orchestration` id. */
  it('Runbook_NoMergePendingRunbook_Remains', () => {
    expect(ALL_RUNBOOKS.filter((r) => r.phase === 'merge-pending')).toEqual([]);
    expect(ALL_RUNBOOKS.map((r) => r.id)).not.toContain('merge-orchestration');
  });

  for (const id of DECISION_RUNBOOK_IDS) {
    describe(id, () => {
      it(`${id}_HasAtLeast2DecideSteps`, () => {
        const runbook = ALL_RUNBOOKS.find(r => r.id === id)!;
        const decideSteps = runbook.steps.filter((s: RunbookStep) => s.decide);
        expect(decideSteps.length).toBeGreaterThanOrEqual(2);
      });

      /** No branch of the four exempt runbooks sets `escalate: true`. For them the test returns before its assertion. */
      it(`${id}_HasAtLeast1EscalateBranch`, () => {
        const exemptFromEscalation = ['task-classification', 'review-strategy', 'design-refinement', 'phase-compression'];
        if (exemptFromEscalation.includes(id)) return;

        const runbook = ALL_RUNBOOKS.find(r => r.id === id)!;
        const hasEscalate = runbook.steps.some((s: RunbookStep) =>
          s.decide && Object.values(s.decide.branches).some(b => b.escalate === true)
        );
        expect(hasEscalate).toBe(true);
      });

      it(`${id}_BranchGuidanceIsActionable`, () => {
        const runbook = ALL_RUNBOOKS.find(r => r.id === id)!;
        for (const step of runbook.steps) {
          if (!step.decide) continue;
          for (const [key, branch] of Object.entries(step.decide.branches)) {
            expect(branch.guidance.length, `${id} step branch "${key}" guidance too short`).toBeGreaterThanOrEqual(20);
          }
        }
      });

      it(`${id}_StepsUseToolNone`, () => {
        const runbook = ALL_RUNBOOKS.find(r => r.id === id)!;
        for (const step of runbook.steps) {
          if (step.decide) {
            expect(step.tool).toBe('none');
            expect(step.action).toBe('decide');
          }
        }
      });
    });
  }
});
