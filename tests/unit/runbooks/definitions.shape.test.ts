import { describe, it, expect } from 'vitest';
import { ALL_RUNBOOKS, SYNTHESIS_FLOW, TASK_COMPLETION, TASK_FIX } from '../../../src/runbooks/definitions.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { RunbookDefinition, RunbookStep } from '../../../src/runbooks/types.js';

// ─── DR-3 / T-05: pin the frozen delegation-stamp parameter shape ───────────
//
// T-04 threaded `riskTier` + `boundaryTouching` — the stamp `prepare_delegation`
// resolves and FREEZES (deriveRiskTier / deriveBoundaryTouching) — through
// TASK_COMPLETION and TASK_FIX so the policy-routed gates that consume it
// (`interpretProbeVerdict`, `resolvePolicySkip`) never see an undefined tier.
// This test PINS that shape: a future edit that silently drops the stamp from
// either the runbook's `templateVars` declaration or a consuming step's
// `params` would relaunder the gate back to the DR-3 defect (an un-probed
// high-tier task laundered into an advisory pass) without any mechanical
// signal — this test is that signal.
//
// The rule encoded: BOTH `riskTier` and `boundaryTouching` must be declared
// templateVars on the runbook AND must appear as `params` on every
// POLICY-ROUTED gate step that actually reads them — precisely the steps
// whose registry schema accepts the fields:
//   - check_test_adequacy   (both TASK_COMPLETION and TASK_FIX)
//   - check_contract_drift  (TASK_COMPLETION only — TASK_FIX has no such step)
//   - check_mock_boundary   (TASK_COMPLETION only — TASK_FIX has no such step)
// `check_static_analysis` is DELIBERATELY excluded (T-04): its registry schema
// does not accept `riskTier` / `boundaryTouching`, so asserting over "every
// step" would be imprecise — this test asserts over the named consumer
// actions only, never blindly over every step in the runbook.
const STAMP_FIELDS = ['riskTier', 'boundaryTouching'] as const;

/** Actions in TASK_COMPLETION / TASK_FIX whose registry schema accepts the
 *  frozen delegation stamp — the policy-routed gates that actually consume
 *  it. `check_static_analysis` is excluded by design (T-04). */
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
    // TASK_FIX only carries the check_test_adequacy consumer — it has no
    // contract-drift or mock-boundary step.
    expectStampBoundAsParams(TASK_FIX, 'check_test_adequacy');
    expect(stepFor(TASK_FIX, 'check_contract_drift')).toBeUndefined();
    expect(stepFor(TASK_FIX, 'check_mock_boundary')).toBeUndefined();
  });

  it('SynthesisFlow_PrepareSynthesisStep_BindsRepoRoot', () => {
    // DR-8 / #1756. `prepare_synthesis` shells out on four legs and refuses to
    // guess which tree they measure, so `repoRoot` is REQUIRED on its action
    // schema. A runbook that names the step without offering the caller a slot
    // for that value hands out a recipe that cannot execute — which is exactly
    // the state this task found: schema, handler and runbook each individually
    // defensible, and the composed path dead.
    const step = SYNTHESIS_FLOW.steps.find((s) => s.action === 'prepare_synthesis');
    expect(step, 'synthesis-flow must have a prepare_synthesis step').toBeDefined();
    expect((step?.params as Record<string, unknown> | undefined)?.repoRoot).toBe('<repoRoot>');
    expect(SYNTHESIS_FLOW.templateVars).toContain('repoRoot');
  });

  it('SynthesisFlow_UsesCreatePrAction_NotBashGh', () => {
    // The canonical flow used to create the PR with a `native:bash` `gh` step,
    // which only a GitHub repository can run — and silently so, because the
    // runbook surface never resolves a native step against the registry, so no
    // check could report that the recipe did not apply to the host. The
    // registered action goes through the provider seam all three implement.
    const step = SYNTHESIS_FLOW.steps.find((s) => s.action === 'create_pr');
    expect(step, 'synthesis-flow must create the PR through the registered action').toBeDefined();
    expect(step?.tool).toBe('exarchos_orchestrate');

    // Nothing in the flow reaches for the CLI directly any more.
    const nativeGh = SYNTHESIS_FLOW.steps.filter(
      (s) => s.tool.startsWith('native:') && /gh|pr[_-]?create/i.test(s.action),
    );
    expect(nativeGh.map((s) => `${s.tool}.${s.action}`)).toEqual([]);

    // The seam-backed action records `pr.created` itself, so the runbook must
    // say so — an agent reads `autoEmits` to decide it need not append the row.
    expect(SYNTHESIS_FLOW.autoEmits).toContain('pr.created');
  });

  it('CheckStaticAnalysis_NeverBindsTheStamp_T04Exclusion', () => {
    // T-04 deliberately did NOT bind riskTier/boundaryTouching on
    // check_static_analysis — its registry schema rejects those fields. If a
    // future edit binds them here, dispatch would fail validation at the
    // static-analysis step (a strict/`.strict()`-style schema rejects unknown
    // keys). Pin the exclusion so that regression is caught here, not at
    // dispatch time.
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

// ─── DR-8 / #1756: a runbook must be able to supply every required field ─────
//
// The pin above names one step. This one derives the rule from the registry, so
// the NEXT action that gains a required field cannot leave its runbook callers
// silently unexecutable — the failure mode 088 hit, where the schema, the
// handler and the runbook were each locally defensible and the composed path
// was dead. A step may satisfy a required field either by pre-filling it in
// `params` or by declaring it as a `templateVar` the orchestrator fills.

describe('Runbook executability (DR-8 / #1756): required fields are reachable', () => {
  it('EveryRunbookStep_RequiredSchemaFields_AreBoundOrDeclared', () => {
    const unbound: string[] = [];
    let checked = 0;

    for (const runbook of ALL_RUNBOOKS) {
      for (const step of runbook.steps) {
        // `native:*` steps address the host harness, not the registry.
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

    // Guard the guard: a derivation that resolved no required fields at all
    // would be vacuously green.
    expect(checked, 'no required fields resolved — the derivation is vacuous')
      .toBeGreaterThan(20);
    expect(
      unbound,
      'each entry is a runbook step whose required field the caller has no way to supply; ' +
        'bind it in step.params or declare it in the runbook templateVars',
    ).toEqual([]);
  });
});
