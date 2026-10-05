// Checks that planner stamps reach dispatch. The registered `prepare_delegation`
// schema keeps the per-task stamp fields, and `applyPlanStamps` lifts plan stamps
// onto bare tasks before classification.

import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from '../../../../src/registry.js';
import { parseTaskStamps } from '../../../../src/verbs/tasks/parse-task-stamps.js';
import { applyPlanStamps, classifyTask } from '../../../../src/verbs/team/prepare-delegation.js';

function prepareDelegationSchema() {
  const tool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
  const action = tool?.actions.find((a) => a.name === 'prepare_delegation');
  if (!action) throw new Error('prepare_delegation action not found in registry');
  return action.schema;
}

describe('#1636 registered schema retains per-task stamps', () => {
  it('RegisteredSchema_TaskWithStamps_FieldsSurviveParse', () => {
    const parsed = prepareDelegationSchema().parse({
      featureId: 'f',
      tasks: [
        {
          id: 'task-001',
          title: 'Wrap the remove path',
          riskTier: 'high',
          boundaryTouching: true,
          files: ['src/verbs/worktree/manager.ts'],
          blockedBy: ['002'],
          testLayer: 'integration',
        },
      ],
    }) as { tasks: Array<Record<string, unknown>> };

    const t = parsed.tasks[0];
    expect(t.riskTier).toBe('high');
    expect(t.boundaryTouching).toBe(true);
    expect(t.files).toEqual(['src/verbs/worktree/manager.ts']);
    expect(t.blockedBy).toEqual(['002']);
    expect(t.testLayer).toBe('integration');
  });

  /** The schema declares the stamp fields. It does not pass undeclared keys through. */
  it('RegisteredSchema_UnknownTaskField_StillStripped', () => {
    const parsed = prepareDelegationSchema().parse({
      featureId: 'f',
      tasks: [{ id: '001', title: 'x', bogusField: 42 }],
    }) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks[0].bogusField).toBeUndefined();
  });

  it('RegisteredSchema_PlanPath_Accepted', () => {
    const parsed = prepareDelegationSchema().parse({
      featureId: 'f',
      planPath: 'docs/specs/some-plan.md',
    }) as { planPath?: string };
    expect(parsed.planPath).toBe('docs/specs/some-plan.md');
  });

  it('RegisteredSchema_BadRiskTier_Rejected', () => {
    expect(() =>
      prepareDelegationSchema().parse({
        featureId: 'f',
        tasks: [{ id: '001', title: 'x', riskTier: 'critical' }],
      }),
    ).toThrow();
  });
});

describe('#1636 applyPlanStamps lifts markdown stamps onto bare tasks', () => {
  it('ApplyPlanStamps_HighBoundaryStamp_ClassifiesHighBoundaryIntegration', () => {
    const stamps = parseTaskStamps(
      '#### Task 001: Wrap the remove path\n**Risk Tier:** high · **Boundary Touching:** true',
    );
    const { tasks } = applyPlanStamps([{ id: 'task-001', title: 'Wrap the remove path' }], stamps);
    expect(tasks[0].riskTier).toBe('high');
    expect(tasks[0].boundaryTouching).toBe(true);

    const c = classifyTask(tasks[0]);
    expect(c.riskTier).toBe('high');
    expect(c.boundaryTouching).toBe(true);
    expect(c.verificationSequence).toContain('check_integration_suite');
  });

  /** The advisory fires only for a tier from the stamp, so a caller tier gives no advisory. */
  it('ApplyPlanStamps_ExplicitCallerField_WinsOverStamp', () => {
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { tasks, advisories } = applyPlanStamps([{ id: '001', title: 'x', riskTier: 'low' }], stamps);
    expect(tasks[0].riskTier).toBe('low');
    expect(advisories).toHaveLength(0);
  });

  /** The heuristic gives `medium` for a bare task, and the plan stamps `high`. */
  it('ApplyPlanStamps_HeuristicDisagreesWithStamp_EmitsAdvisory', () => {
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { advisories } = applyPlanStamps([{ id: '001', title: 'x' }], stamps);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('high');
    expect(advisories[0]).toContain('medium');
  });

  /** The heuristic gives `high` for a `.d.ts` file, so the `high` stamp agrees. */
  it('ApplyPlanStamps_StampAgreesWithHeuristic_NoAdvisory', () => {
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { advisories } = applyPlanStamps(
      [{ id: '001', title: 'x', files: ['src/types/foo.d.ts'] }],
      stamps,
    );
    expect(advisories).toHaveLength(0);
  });

  it('ApplyPlanStamps_UnmatchedTask_PassesThroughUnchanged', () => {
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { tasks } = applyPlanStamps([{ id: '999', title: 'orphan' }], stamps);
    expect(tasks[0].riskTier).toBeUndefined();
    expect(tasks[0].boundaryTouching).toBeUndefined();
  });
});
