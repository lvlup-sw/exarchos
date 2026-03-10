import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS } from './definitions.js';
import type { RunbookStep } from './types.js';

const DECISION_RUNBOOK_IDS = [
  'triage-decision',
  'investigation-decision',
  'scope-decision',
  'dispatch-decision',
  'review-escalation',
  'shepherd-escalation',
];

describe('Decision runbooks', () => {
  it('decisionRunbooks_AllRegistered', () => {
    const registeredIds = ALL_RUNBOOKS.map(r => r.id);
    for (const id of DECISION_RUNBOOK_IDS) {
      expect(registeredIds).toContain(id);
    }
  });

  for (const id of DECISION_RUNBOOK_IDS) {
    describe(id, () => {
      it(`${id}_HasAtLeast2DecideSteps`, () => {
        const runbook = ALL_RUNBOOKS.find(r => r.id === id)!;
        const decideSteps = runbook.steps.filter((s: RunbookStep) => s.decide);
        expect(decideSteps.length).toBeGreaterThanOrEqual(2);
      });

      it(`${id}_HasAtLeast1EscalateBranch`, () => {
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
