import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS } from './definitions.js';
import { findActionInRegistry } from '../registry.js';

// ─── DR-1 / T-02: `task_complete` must be the TERMINAL step ─────────────────
//
// The delegation contract: a task marked complete has already passed every
// gate that could block it. If a BLOCKING gate ran after `task_complete`, a
// task could be recorded complete and only THEN fail its last gate — the
// exact defect WFQ-004 named (`check_integration_suite` used to sit after
// `task_complete` in TASK_COMPLETION).
//
// This asserts the invariant over EVERY runbook in the registry — enumerated
// programmatically from `ALL_RUNBOOKS`, not a hardcoded list of two — so a
// future runbook (or a re-ordering of an existing one) cannot silently
// reintroduce the defect. Blocking-ness is read from the SAME model the
// gate-runner / task_complete gate enforcement uses: `action.gate.blocking`
// in the tool-action registry, resolved via `findActionInRegistry`. This test
// does not restate a local list of which gates are blocking — it defers
// entirely to the registry's own declaration.
describe('Runbook ordering invariant (DR-1 / WFQ-004)', () => {
  it('RunbookOrdering_NoBlockingGateFollowsTaskComplete', () => {
    const violations: string[] = [];

    for (const runbook of ALL_RUNBOOKS) {
      const completeIndex = runbook.steps.findIndex(
        (step) => step.tool === 'exarchos_orchestrate' && step.action === 'task_complete',
      );
      // A runbook with no `task_complete` step (review/merge/decision
      // runbooks) has nothing to enforce ordering against — skip it.
      if (completeIndex === -1) continue;

      const stepsAfter = runbook.steps.slice(completeIndex + 1);
      for (const step of stepsAfter) {
        if (step.tool.startsWith('native:') || step.tool === 'none') continue;

        const action = findActionInRegistry(step.tool, step.action);
        if (action?.gate?.blocking === true) {
          violations.push(
            `Runbook '${runbook.id}': blocking gate '${step.tool}.${step.action}' ` +
              `runs AFTER 'task_complete' (index ${completeIndex}) — task_complete must be terminal`,
          );
        }
      }
    }

    expect(
      violations,
      `Blocking gate(s) found after task_complete:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('RunbookOrdering_TaskCompletionAndTaskFix_HaveTaskCompleteAsLastStep', () => {
    // Characterization for the two runbooks that actually own a per-task
    // completion chain today: task_complete is not merely "not followed by a
    // blocking gate" — it is the LAST step, full stop. Any step landing after
    // it (blocking or not) would mean the runbook keeps doing per-task work
    // post-completion, which contradicts the "terminal step" contract.
    const runbooksWithTaskComplete = ALL_RUNBOOKS.filter((runbook) =>
      runbook.steps.some(
        (step) => step.tool === 'exarchos_orchestrate' && step.action === 'task_complete',
      ),
    );

    expect(
      runbooksWithTaskComplete.map((r) => r.id).sort(),
      'expected exactly task-completion and task-fix to carry a task_complete step',
    ).toEqual(['task-completion', 'task-fix']);

    for (const runbook of runbooksWithTaskComplete) {
      const lastStep = runbook.steps[runbook.steps.length - 1];
      expect(
        lastStep?.action,
        `Runbook '${runbook.id}': task_complete must be the LAST step`,
      ).toBe('task_complete');
    }
  });
});
