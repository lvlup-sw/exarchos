/**
 * The integration-suite leaf of the task-completion segment.
 *
 * The leaf runs after mock boundary, so a task that the earlier gates refuse runs no suite.
 * It runs before static analysis, because `task_complete` and the trace read the row of static analysis, so that gate stays last.
 *
 * @oracle-sources: ../../../src/runbooks/definitions.ts, the segment that the production compiler builds from the shipped runbook
 */

import { describe, expect, it } from 'vitest';

import { compileIntent, PRODUCTION_COMPILE_DEPS } from '../../../src/verbs/execute/compile.js';
import { TASK_COMPLETION_LEAF_CLASSES } from '../../../src/verbs/settle/settlement-reads.js';

describe('the integration-suite leaf of the segment', () => {
  it('TaskCompletion_AHighTierSegment_RunsTheSuiteAfterMockBoundaryAndBeforeStaticAnalysis', () => {
    const outcome = compileIntent(
      'task-completion',
      { streamId: 'wf-live' },
      { taskId: 'task-9', worktreePath: '/tmp/agent-wt', riskTier: 'high', boundaryTouching: true, baseRef: 'feature/wave' },
      PRODUCTION_COMPILE_DEPS,
    );
    if (!outcome.ok) throw new Error(outcome.refusal.message);

    const { leaves } = outcome.segment;
    const actions = leaves.map((leaf) => leaf.action);
    const suiteIndex = actions.indexOf('check_integration_suite');
    expect(suiteIndex).toBeGreaterThan(0);
    expect(actions[suiteIndex - 1]).toBe('check_mock_boundary');
    expect(actions[suiteIndex + 1]).toBe('check_static_analysis');

    const suite = leaves[suiteIndex];
    expect(suite?.onFail).toBe('stop');
    expect(suite?.declaration.gate?.blocking).toBe(true);
    expect(suite?.args).toMatchObject({
      repoRoot: 'auto',
      worktreePath: '/tmp/agent-wt',
      riskTier: 'high',
      boundaryTouching: true,
      baseBranch: 'feature/wave',
      featureId: 'wf-live',
      taskId: 'task-9',
    });
    expect(TASK_COMPLETION_LEAF_CLASSES.check_integration_suite).toBe('gate');
  });
});
