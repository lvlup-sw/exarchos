import { describe, it, expect } from 'vitest';
import { TASK_COMPLETION, TASK_FIX } from './definitions.js';
import type { RunbookDefinition, RunbookStep } from './types.js';

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
