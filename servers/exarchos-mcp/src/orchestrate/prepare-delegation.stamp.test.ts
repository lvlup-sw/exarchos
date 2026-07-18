// ─── #1636 Regression: planner stamps reach dispatch ─────────────────────────
//
// These tests pin the two halves of the #1636 fix that the existing
// prepare-delegation tests do NOT cover:
//   1. the REGISTERED MCP schema no longer strips per-task stamps (previously
//      `tasks: z.array(z.object({ id, title }))` dropped them before the handler
//      ever ran — the bug's structural root);
//   2. the plan-stamp lift + classification: a high+boundary stamped task yields
//      riskTier:high / boundaryTouching:true / a verification sequence that
//      includes the integration-suite rung.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY } from '../registry.js';
import { parseTaskStamps } from './parse-task-stamps.js';
import { applyPlanStamps, classifyTask } from './prepare-delegation.js';

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
          files: ['servers/exarchos-mcp/src/orchestrate/worktree/manager.ts'],
          blockedBy: ['002'],
          testLayer: 'integration',
        },
      ],
    }) as { tasks: Array<Record<string, unknown>> };

    const t = parsed.tasks[0];
    // The exact fields that #1636 reported as silently stripped MUST survive.
    expect(t!.riskTier).toBe('high');
    expect(t!.boundaryTouching).toBe(true);
    expect(t!.files).toEqual(['servers/exarchos-mcp/src/orchestrate/worktree/manager.ts']);
    expect(t!.blockedBy).toEqual(['002']);
    expect(t!.testLayer).toBe('integration');
  });

  it('RegisteredSchema_UnknownTaskField_StillStripped', () => {
    // We widened the schema deliberately, not by opening it to passthrough — an
    // undeclared key is still dropped.
    const parsed = prepareDelegationSchema().parse({
      featureId: 'f',
      tasks: [{ id: '001', title: 'x', bogusField: 42 }],
    }) as { tasks: Array<Record<string, unknown>> };
    expect(parsed.tasks[0]!.bogusField).toBeUndefined();
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
    // The orchestrator passes only {id, title} today — that is the bug's input.
    const { tasks } = applyPlanStamps([{ id: 'task-001', title: 'Wrap the remove path' }], stamps);
    expect(tasks[0]!.riskTier).toBe('high');
    expect(tasks[0]!.boundaryTouching).toBe(true);

    const c = classifyTask(tasks[0]!);
    expect(c.riskTier).toBe('high');
    expect(c.boundaryTouching).toBe(true);
    expect(c.verificationSequence).toContain('check_integration_suite');
  });

  it('ApplyPlanStamps_ExplicitCallerField_WinsOverStamp', () => {
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { tasks, advisories } = applyPlanStamps([{ id: '001', title: 'x', riskTier: 'low' }], stamps);
    expect(tasks[0]!.riskTier).toBe('low'); // caller-supplied value is never overridden
    // The caller's own value must NOT be misattributed to the plan stamp — the
    // advisory only fires for a stamp-sourced tier (CodeRabbit/Sentry).
    expect(advisories).toHaveLength(0);
  });

  it('ApplyPlanStamps_HeuristicDisagreesWithStamp_EmitsAdvisory', () => {
    // Bare {id,title} → heuristic derives `medium`; the plan stamps `high`.
    const stamps = parseTaskStamps('#### Task 001: x\n**Risk Tier:** high');
    const { advisories } = applyPlanStamps([{ id: '001', title: 'x' }], stamps);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('high');
    expect(advisories[0]).toContain('medium');
  });

  it('ApplyPlanStamps_StampAgreesWithHeuristic_NoAdvisory', () => {
    // A schema file → heuristic already derives `high`; stamp `high` agrees.
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
    expect(tasks[0]!.riskTier).toBeUndefined();
    expect(tasks[0]!.boundaryTouching).toBeUndefined();
  });
});
