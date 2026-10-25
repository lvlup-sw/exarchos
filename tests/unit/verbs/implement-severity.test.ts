// Tests for the severity and the graduation mode of IMPLEMENT phases, through the gate severity wrapper.
//
// 1. Severity is per workflow. A failing ladder gate is advisory for `oneshot`, and blocks for `debug`, `feature` and `refactor`.
// 2. In `audit` mode, a failing ladder gate becomes advisory for any severity.
// 3. A `.exarchos.yml` `review.gates.<gate>` override applies to IMPLEMENT phases.
//
// The subject of the first describe is `withGateSeverity`. The wrapper takes the workflow type from its resolver, and the mode from that type.
// The mode map is per workflow, so it stays out of the kind table.

import { describe, it, expect } from 'vitest';
import {
  resolveImplementMode,
  resolvePhaseMode,
  IMPLEMENT_PHASE_MODE,
} from '../../../src/verbs/gates/gate-utils.js';
import { withGateSeverity } from '../../../src/verbs/gates/gate-severity.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../src/events/store.js';
import type { ToolResult } from '../../../src/format.js';
import type { PhaseKind } from '../../../src/workflow/phase-kind.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../../../src/workflow/verification-policy.js';

/** The first ladder gate, `check_static_analysis`. The per-workflow severity default applies only to ladder gates. */
const LADDER_GATE = VERIFICATION_GATE_NAMES[0];

/** The descriptor of the ladder gate, as the wrapper reads it. The gate declares no signal row. */
const LADDER_DESCRIPTOR = { name: LADDER_GATE, dimension: 'D2', signal: false };

/** A failing ladder verdict: `success: true` with `data.passed: false`. */
async function failingVerdict(): Promise<ToolResult> {
  return { success: true, data: { passed: false } };
}

function configWith(overrides: Partial<ResolvedProjectConfig['review']>): ResolvedProjectConfig {
  return { ...DEFAULTS, review: { ...DEFAULTS.review, ...overrides } };
}

/** A wiring context with the project config of the call. The wrapper reads no store here, because the workflow type comes from the stub resolver. */
function contextWith(projectConfig: ResolvedProjectConfig | undefined): DispatchContext {
  return {
    stateDir: '/unused-implement-severity-state',
    eventStore: new EventStore('/unused-implement-severity-state'),
    enableTelemetry: false,
    ...(projectConfig === undefined ? {} : { projectConfig }),
  };
}

/** Runs the failing ladder gate through the wrapper for one workflow type and one project config. */
async function throughTheWrapper(
  workflowType: string,
  projectConfig: ResolvedProjectConfig | undefined,
): Promise<ToolResult> {
  const wrapped = withGateSeverity(LADDER_DESCRIPTOR, failingVerdict, async () => workflowType);
  return wrapped({ featureId: 'feat-implement-severity' }, '/unused-implement-severity-state', contextWith(projectConfig));
}

/** The `passed` field of a result. */
function passedOf(result: ToolResult): unknown {
  const data = result.data;
  return data !== null && typeof data === 'object' && 'passed' in data ? data.passed : undefined;
}

/**
 * The workflow type of each IMPLEMENT phase: `oneshot:implementing` is `oneshot`, which is advisory.
 * `debug-implement` is `debug`, `delegate` is `feature`, and `polish-implement` is `refactor`. These three block.
 */
const ONESHOT = 'oneshot';
const BLOCKING_WORKFLOWS = ['debug', 'feature', 'refactor'] as const;

describe('implement-phase severity through the gate severity wrapper', () => {
  /**
   * For `oneshot`, both the ladder default severity and the audit mode make the failure advisory.
   * The result sets `data.passed` to true and adds a warning. The orchestrator reads `data.passed`.
   */
  it('ImplementSeverity_Oneshot_Advisory', async () => {
    const result = await throughTheWrapper(ONESHOT, DEFAULTS);
    expect(result.success).toBe(true);
    expect(passedOf(result)).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  /** The blocking workflow types are in `enforce` mode, so the failure stays: `data.passed` is false, and the result has no warning. */
  it('ImplementSeverity_FeatureDebugRefactor_Blocking', async () => {
    for (const workflowType of BLOCKING_WORKFLOWS) {
      const result = await throughTheWrapper(workflowType, DEFAULTS);
      expect(passedOf(result)).toBe(false);
      expect(result.warnings ?? []).toHaveLength(0);
    }
  });

  /**
   * In `audit` mode, a failing ladder gate becomes advisory, also when the config makes the gate blocking.
   * A warning holds the finding, and the warning names the audit mode. The result sets `data.passed` to true.
   */
  it('ImplementMode_AuditMode_DoesNotBlock', async () => {
    const blocking = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: true, params: {} } },
    });
    const result = await throughTheWrapper(ONESHOT, blocking);
    expect(result.success).toBe(true);
    expect(passedOf(result)).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((warning) => warning.includes('audit mode'))).toBe(true);
  });

  /**
   * The mode comes from the workflow type and not from the project config.
   * As a result, audit mode makes the failure advisory even when no project config resolves.
   */
  it('ImplementMode_AuditMode_NoConfig_StillDoesNotBlock', async () => {
    const result = await throughTheWrapper(ONESHOT, undefined);
    expect(result.success).toBe(true);
    expect(passedOf(result)).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  /** A severity downgrade reads the project config, so without a config an `enforce` workflow still blocks. */
  it('ImplementSeverity_NoConfig_EnforceStillBlocks', async () => {
    const result = await throughTheWrapper('feature', undefined);
    expect(passedOf(result)).toBe(false);
    expect(result.warnings ?? []).toHaveLength(0);
  });

  /**
   * A `review.gates` override sets the ladder gate to warning-only.
   * Under `enforce` mode, the failure becomes advisory, with the same result for `feature` and `debug`.
   */
  it('ImplementOverride_ReviewGatesConfig_AppliesToImplementPhases', async () => {
    const config = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: false, params: {} } },
    });
    const feature = await throughTheWrapper('feature', config);
    const debug = await throughTheWrapper('debug', config);
    expect(feature.success).toBe(true);
    expect(passedOf(feature)).toBe(true);
    expect(feature.warnings!.length).toBeGreaterThan(0);
    expect(debug.success).toBe(true);
    expect(passedOf(debug)).toBe(true);
    expect(debug.warnings!.length).toBeGreaterThan(0);
  });
});

describe('implement-phase mode map', () => {
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
   * The severity wrapper resolves the mode through `resolvePhaseMode`.
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
