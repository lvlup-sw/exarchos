import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS } from '../../../src/runbooks/definitions.js';
import { findActionInRegistry } from '../../../src/registry.js';

/**
 * A task that is complete passed every gate that can block it. Thus no blocking gate can run
 * after `task_complete`. Each test reads every runbook in `ALL_RUNBOOKS`, so a new runbook
 * cannot skip the check.
 */
describe('Runbook ordering invariant (DR-1 / WFQ-004)', () => {
  /**
   * A runbook without a `task_complete` step has no order to check. The registry field
   * `gate.blocking` decides which steps block, so the test holds no list of blocking gates.
   */
  it('RunbookOrdering_NoBlockingGateFollowsTaskComplete', () => {
    const violations: string[] = [];

    for (const runbook of ALL_RUNBOOKS) {
      const completeIndex = runbook.steps.findIndex(
        (step) => step.tool === 'exarchos_orchestrate' && step.action === 'task_complete',
      );
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

  /**
   * Only `task-completion` and `task-fix` hold a `task_complete` step, and it is their last step.
   * A step after it is a fault, also when that step does not block.
   */
  it('RunbookOrdering_TaskCompletionAndTaskFix_HaveTaskCompleteAsLastStep', () => {
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

  /**
   * `resolveRepoRoot` resolves `'auto'` from a `worktreePath`, or from the latest
   * `worktree.created` event for a `taskId`. A step that pins `repoRoot: 'auto'` and binds neither
   * can never resolve its root. Such a step must bind one of them, or use a `'<repoRoot>'`
   * template variable.
   */
  it('RunbookParams_RepoRootAuto_AlwaysBindsWorktreePathOrTaskId', () => {
    const violations: string[] = [];

    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        const params = step.params as Readonly<Record<string, unknown>> | undefined;
        if (params?.['repoRoot'] !== 'auto') continue;
        const hasWorktreePath = typeof params['worktreePath'] === 'string';
        const hasTaskId = typeof params['taskId'] === 'string';
        if (!hasWorktreePath && !hasTaskId) {
          violations.push(
            `Runbook '${runbook.id}' step '${step.tool}.${step.action}': ` +
              `repoRoot:'auto' with neither worktreePath nor taskId can never resolve ` +
              `(resolveRepoRoot fails closed) — bind one of them, or use a '<repoRoot>' template var`,
          );
        }
      }
    }

    expect(
      violations,
      `Un-resolvable repoRoot:'auto' step(s):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
