import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS, SYNTHESIS_FLOW, TASK_COMPLETION, TASK_FIX } from '../../../src/runbooks/definitions.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { RunbookDefinition, RunbookStep } from '../../../src/runbooks/types.js';

/**
 * The delegation stamp that `prepare_delegation` freezes. `TASK_COMPLETION` and
 * `TASK_FIX` must declare both fields as `templateVars`, and each gate step that
 * reads the stamp must bind both as `params`. Without the stamp the gate reads an
 * unset tier, and a high-tier task with no kill probe can get an advisory skip.
 */
const STAMP_FIELDS = ['riskTier', 'boundaryTouching'] as const;

/**
 * The gate actions whose registry schema accepts the stamp. Of these, `TASK_FIX` has
 * only the `check_test_adequacy` step. `check_static_analysis` is not in the list,
 * because its schema does not declare the two fields.
 */
const STAMP_CONSUMING_ACTIONS = [
  'check_test_adequacy',
  'check_contract_drift',
  'check_mock_boundary',
] as const;

function stepFor(runbook: RunbookDefinition, action: string): RunbookStep | undefined {
  return runbook.steps.find((s) => s.action === action);
}

function expectStampDeclaredAsTemplateVars(runbook: RunbookDefinition): void {
  for (const field of STAMP_FIELDS) {
    expect(
      runbook.templateVars,
      `Runbook '${runbook.id}' must declare '${field}' as a templateVar`,
    ).toContain(field);
  }
}

function expectStampBoundAsParams(runbook: RunbookDefinition, action: string): void {
  const step = stepFor(runbook, action);
  expect(step, `Runbook '${runbook.id}' must have a '${action}' step`).toBeDefined();
  if (step === undefined) return;

  const params = step.params as Readonly<Record<string, unknown>> | undefined;
  expect(
    params,
    `Runbook '${runbook.id}' step '${action}' must pre-fill params`,
  ).toBeDefined();
  if (params === undefined) return;

  for (const field of STAMP_FIELDS) {
    expect(
      params[field],
      `Runbook '${runbook.id}' step '${action}' must bind '${field}' as a param`,
    ).toBe(`<${field}>`);
  }
}

describe('Runbook parameter shape (DR-3 / T-05): delegation stamp threading', () => {
  it('TaskCompletion_DeclaresStampAsTemplateVars', () => {
    expectStampDeclaredAsTemplateVars(TASK_COMPLETION);
  });

  it('TaskFix_DeclaresStampAsTemplateVars', () => {
    expectStampDeclaredAsTemplateVars(TASK_FIX);
  });

  it('TaskCompletion_EveryStampConsumingStep_BindsBothStampFields', () => {
    for (const action of STAMP_CONSUMING_ACTIONS) {
      expectStampBoundAsParams(TASK_COMPLETION, action);
    }
  });

  it('TaskFix_StampConsumingStep_BindsBothStampFields', () => {
    expectStampBoundAsParams(TASK_FIX, 'check_test_adequacy');
    expect(stepFor(TASK_FIX, 'check_contract_drift')).toBeUndefined();
    expect(stepFor(TASK_FIX, 'check_mock_boundary')).toBeUndefined();
  });

  /**
   * The `prepare_synthesis` schema requires `repoRoot`, because its checks run
   * commands in that directory. A runbook step that gives the caller no slot for
   * `repoRoot` cannot run.
   */
  it('SynthesisFlow_PrepareSynthesisStep_BindsRepoRoot', () => {
    const step = SYNTHESIS_FLOW.steps.find((s) => s.action === 'prepare_synthesis');
    expect(step, 'synthesis-flow must have a prepare_synthesis step').toBeDefined();
    expect((step?.params as Record<string, unknown> | undefined)?.repoRoot).toBe('<repoRoot>');
    expect(SYNTHESIS_FLOW.templateVars).toContain('repoRoot');
  });

  /**
   * The `check_static_analysis` schema does not declare the stamp fields, and dispatch
   * refuses an undeclared field. A runbook that binds them there fails at that step.
   */
  it('CheckStaticAnalysis_NeverBindsTheStamp_T04Exclusion', () => {
    for (const runbook of [TASK_COMPLETION, TASK_FIX]) {
      const step = stepFor(runbook, 'check_static_analysis');
      expect(step, `Runbook '${runbook.id}' must have a check_static_analysis step`).toBeDefined();
      if (step === undefined) continue;
      const params = step.params as Readonly<Record<string, unknown>> | undefined;
      for (const field of STAMP_FIELDS) {
        expect(
          params?.[field],
          `Runbook '${runbook.id}' step 'check_static_analysis' must NOT bind '${field}' (T-04 exclusion)`,
        ).toBeUndefined();
      }
    }
  });
});

/**
 * Derives the rule from the registry. Each required schema field of a runbook step
 * must be a key of the step `params` or a `templateVar` of the runbook. Thus an
 * action that gets a new required field fails here until each runbook can supply it.
 */
describe('Runbook executability (DR-8 / #1756): required fields are reachable', () => {
  /**
   * The loop skips a step that the registry does not hold, such as a `native:*`
   * step for the host harness. The minimum on `checked` fails a derivation that
   * resolves no required field.
   */
  it('EveryRunbookStep_RequiredSchemaFields_AreBoundOrDeclared', () => {
    const unbound: string[] = [];
    let checked = 0;

    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        const tool = TOOL_REGISTRY.find((t) => t.name === step.tool);
        const action = tool?.actions.find((a) => a.name === step.action);
        if (action === undefined) continue;

        const shape = (action.schema as unknown as {
          shape: Record<string, { isOptional(): boolean }>;
        }).shape;
        const params = (step.params ?? {}) as Readonly<Record<string, unknown>>;

        for (const [field, zodType] of Object.entries(shape)) {
          if (zodType.isOptional()) continue;
          checked += 1;
          const bound = Object.prototype.hasOwnProperty.call(params, field);
          const declared = runbook.templateVars.includes(field);
          if (!bound && !declared) {
            unbound.push(`${runbook.id} :: ${step.tool}.${step.action} :: ${field}`);
          }
        }
      }
    }

    expect(checked, 'no required fields resolved — the derivation is vacuous')
      .toBeGreaterThan(20);
    expect(
      unbound,
      'each entry is a runbook step whose required field the caller has no way to supply; ' +
        'bind it in step.params or declare it in the runbook templateVars',
    ).toEqual([]);
  });
});
