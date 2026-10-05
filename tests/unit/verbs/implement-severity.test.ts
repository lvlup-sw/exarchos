// Tests for the severity and graduation mode of IMPLEMENT phases.
//
// 1. Severity is per workflow. Under `enforce` mode, a failing ladder gate is advisory
//    for `oneshot`, and blocks for `debug`, `feature`, and `refactor`.
// 2. In `audit` mode, a failing ladder gate becomes advisory for any severity.
// 3. A `.exarchos.yml` `review.gates.<gate>` override applies to IMPLEMENT phases.
//
// The subjects are `applyLadderGateSeverity` and the mode map by workflow type.
// The mode map is per workflow, so it stays out of the kind table.

import { describe, it, expect } from 'vitest';
import {
  applyLadderGateSeverity,
  resolveImplementMode,
  resolvePhaseMode,
  IMPLEMENT_PHASE_MODE,
} from '../../../src/verbs/gates/gate-utils.js';
import type { PhaseKind } from '../../../src/workflow/phase-kind.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../../../src/workflow/verification-policy.js';

/** The first ladder gate, `check_static_analysis`. The per-workflow severity default applies only to ladder gates. */
const LADDER_GATE = VERIFICATION_GATE_NAMES[0];

/** A failing ladder verdict: `success: true` with `data.passed: false`. */
function failingVerdict(): { success: true; data: { passed: false } } {
  return { success: true, data: { passed: false } };
}

function configWith(overrides: Partial<ResolvedProjectConfig['review']>): ResolvedProjectConfig {
  return { ...DEFAULTS, review: { ...DEFAULTS.review, ...overrides } };
}

/**
 * The workflow type of each IMPLEMENT phase: `oneshot:implementing` is `oneshot`, which is advisory.
 * `debug-implement` is `debug`, `delegate` is `feature`, and `polish-implement` is `refactor`. These three block.
 */
const ONESHOT = 'oneshot';
const BLOCKING_WORKFLOWS = ['debug', 'feature', 'refactor'] as const;

describe('DR-6 implement-phase severity', () => {
  /**
   * The binding is in `enforce` mode, so only the oneshot severity can make the failure advisory.
   * The result sets `data.passed` to true and adds a warning. The orchestrator reads `data.passed`.
   */
  it('ImplementSeverity_Oneshot_Advisory', () => {
    const result = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      DEFAULTS,
      failingVerdict(),
      ONESHOT,
      'enforce',
    );
    expect(result.success).toBe(true);
    expect((result.data as { passed?: unknown }).passed).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  /** Under `enforce` mode, the failure stays: `data.passed` is false, and the result has no warning. */
  it('ImplementSeverity_FeatureDebugRefactor_Blocking', () => {
    for (const workflowType of BLOCKING_WORKFLOWS) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        DEFAULTS,
        failingVerdict(),
        workflowType,
        'enforce',
      );
      expect((result.data as { passed?: unknown }).passed).toBe(false);
      expect(result.warnings ?? []).toHaveLength(0);
    }
  });

  /**
   * In `audit` mode, a failing ladder gate becomes advisory, even for a blocking workflow type.
   * A warning holds the finding. The result sets `data.passed` to true, so the orchestrator does not block.
   */
  it('ImplementMode_AuditMode_DoesNotBlock', () => {
    for (const workflowType of BLOCKING_WORKFLOWS) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        DEFAULTS,
        failingVerdict(),
        workflowType,
        'audit',
      );
      expect(result.success).toBe(true);
      expect((result.data as { passed?: unknown }).passed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
    }
  });

  /**
   * The mode comes from the workflow type and not from the project config.
   * As a result, audit mode makes the failure advisory even when no project config resolves.
   */
  it('ImplementMode_AuditMode_NoConfig_StillDoesNotBlock', () => {
    for (const workflowType of [ONESHOT, 'debug'] as const) {
      const result = applyLadderGateSeverity(
        LADDER_GATE,
        'D2',
        undefined,
        failingVerdict(),
        workflowType,
        'audit',
      );
      expect(result.success).toBe(true);
      expect((result.data as { passed?: unknown }).passed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
    }
  });

  /** A severity downgrade reads the project config, so without a config an `enforce` binding still blocks. */
  it('ImplementSeverity_NoConfig_EnforceStillBlocks', () => {
    const result = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      undefined,
      failingVerdict(),
      ONESHOT,
      'enforce',
    );
    expect((result.data as { passed?: unknown }).passed).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
  });

  /**
   * A `review.gates` override sets the ladder gate to warning-only.
   * Under `enforce` mode, the failure becomes advisory, with the same result for `feature` and `debug`.
   */
  it('ImplementOverride_ReviewGatesConfig_AppliesToImplementPhases', () => {
    const config = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: false, params: {} } },
    });
    const feature = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      config,
      failingVerdict(),
      'feature',
      'enforce',
    );
    const debug = applyLadderGateSeverity(
      LADDER_GATE,
      'D2',
      config,
      failingVerdict(),
      'debug',
      'enforce',
    );
    expect(feature.success).toBe(true);
    expect((feature.data as { passed?: unknown }).passed).toBe(true);
    expect(feature.warnings!.length).toBeGreaterThan(0);
    expect(debug.success).toBe(true);
    expect((debug.data as { passed?: unknown }).passed).toBe(true);
    expect(debug.warnings!.length).toBeGreaterThan(0);
  });
});

describe('DR-6 implement-phase mode map', () => {
  /**
   * The mode map uses the workflow type as key, not the phase kind.
   * `oneshot` is `audit`. The blocking workflows and an unknown type are `enforce`.
   */
  it('ImplementPhaseMode_OneshotAudit_BlockingWorkflowsEnforce', () => {
    expect(resolveImplementMode('oneshot')).toBe('audit');
    expect(resolveImplementMode('feature')).toBe('enforce');
    expect(resolveImplementMode('debug')).toBe('enforce');
    expect(resolveImplementMode('refactor')).toBe('enforce');
    expect(resolveImplementMode('unknown-future-type')).toBe('enforce');
  });

  /** The map is a frozen data table, so a new workflow type is one entry and not new control flow. */
  it('ImplementPhaseMode_TableIsFrozen', () => {
    expect(Object.isFrozen(IMPLEMENT_PHASE_MODE)).toBe(true);
  });

  /**
   * `composite.ts` resolves the mode through `resolvePhaseMode`.
   * For IMPLEMENT, the result equals `resolveImplementMode` for each workflow type.
   * Each other kind gets `enforce`, so a phase outside IMPLEMENT is never downgraded.
   */
  it('ResolvePhaseMode_ProductionSoT_EquivalentForImplement_EnforceElsewhere', () => {
    const workflowTypes = ['oneshot', 'feature', 'debug', 'refactor', 'unknown-future-type'];
    for (const wt of workflowTypes) {
      expect(resolvePhaseMode('IMPLEMENT', wt)).toBe(resolveImplementMode(wt));
    }
    const nonImplement: readonly PhaseKind[] = ['PLAN', 'REVIEW', 'SYNTHESIZE', 'GATHER'];
    for (const kind of nonImplement) {
      for (const wt of workflowTypes) {
        expect(resolvePhaseMode(kind, wt)).toBe('enforce');
      }
    }
  });
});
