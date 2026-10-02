import { describe, it, expect } from 'vitest';
import { resolveGateSeverity, WORKFLOW_DEFAULT_SEVERITY } from '../../../../src/verbs/gates/gate-severity.js';
import { DEFAULTS } from '../../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../../../../src/workflow/verification-policy.js';

/** Returns `DEFAULTS` with the given `review` fields replaced. */
function configWith(overrides: Partial<ResolvedProjectConfig['review']>): ResolvedProjectConfig {
  return {
    ...DEFAULTS,
    review: { ...DEFAULTS.review, ...overrides },
  };
}

describe('resolveGateSeverity', () => {
  it('resolveGateSeverity_NoOverrides_ReturnsBlocking', () => {
    const result = resolveGateSeverity('security-scan', 'D1', DEFAULTS);
    expect(result).toBe('blocking');
  });

  it('resolveGateSeverity_DimensionWarning_ReturnsWarning', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D3: { severity: 'warning', enabled: true } },
    });
    expect(resolveGateSeverity('context-economy', 'D3', config)).toBe('warning');
  });

  it('resolveGateSeverity_DimensionDisabled_ReturnsDisabled', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D5: { severity: 'disabled', enabled: false } },
    });
    expect(resolveGateSeverity('workflow-determinism', 'D5', config)).toBe('disabled');
  });

  it('resolveGateSeverity_GateBlockingTrue_OverridesDimension', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D3: { severity: 'warning', enabled: true } },
      gates: { 'context-economy': { enabled: true, blocking: true, params: {} } },
    });
    expect(resolveGateSeverity('context-economy', 'D3', config)).toBe('blocking');
  });

  it('resolveGateSeverity_GateBlockingFalse_OverridesDimension', () => {
    const config = configWith({
      gates: { 'tdd-compliance': { enabled: true, blocking: false, params: {} } },
    });
    expect(resolveGateSeverity('tdd-compliance', 'D1', config)).toBe('warning');
  });

  it('resolveGateSeverity_GateDisabled_OverridesDimension', () => {
    const config = configWith({
      gates: { 'error-handling-audit': { enabled: false, blocking: true, params: {} } },
    });
    expect(resolveGateSeverity('error-handling-audit', 'D4', config)).toBe('disabled');
  });

  it('resolveGateSeverity_GateEnabled_DimensionDisabled_RespectsGate', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D5: { severity: 'disabled', enabled: false } },
      gates: { 'workflow-determinism': { enabled: true, blocking: true, params: {} } },
    });
    expect(resolveGateSeverity('workflow-determinism', 'D5', config)).toBe('blocking');
  });

  it('resolveGateSeverity_UnknownGate_FallsBackToDimension', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D3: { severity: 'warning', enabled: true } },
    });
    expect(resolveGateSeverity('unknown-gate', 'D3', config)).toBe('warning');
  });

  it('resolveGateSeverity_UnknownDimension_DefaultsBlocking', () => {
    expect(resolveGateSeverity('some-gate', 'D99', DEFAULTS)).toBe('blocking');
  });
});

/** The first ladder gate, `check_static_analysis`. */
const LADDER_GATE = VERIFICATION_GATE_NAMES[0];

/**
 * Under an `oneshot` workflow, a ladder gate resolves to `warning`, unless `review.gates[gateName]` sets it.
 * The data table `WORKFLOW_DEFAULT_SEVERITY` holds the workflow defaults.
 * A non-ladder gate, another workflow, and an omitted `workflowType` resolve without the table.
 */
describe('resolveGateSeverity per-workflow severity', () => {
  it('WORKFLOW_DEFAULT_SEVERITY_OneshotEntry_IsWarning', () => {
    expect(WORKFLOW_DEFAULT_SEVERITY.oneshot).toBe('warning');
  });

  it('ResolveGateSeverity_OneshotLadderGate_DefaultsToWarning', () => {
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS, 'oneshot')).toBe('warning');
  });

  it('ResolveGateSeverity_OneshotWithExplicitGateOverride_OverrideWins', () => {
    const config = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: true, params: {} } },
    });
    expect(resolveGateSeverity(LADDER_GATE, 'D2', config, 'oneshot')).toBe('blocking');
  });

  it('ResolveGateSeverity_OneshotNonLadderGate_UnchangedResolution', () => {
    expect(resolveGateSeverity('security-scan', 'D1', DEFAULTS, 'oneshot')).toBe('blocking');
  });

  /** An explicit `enabled: false` on the dimension beats the oneshot default, so the gate resolves to `disabled`. */
  it('ResolveGateSeverity_OneshotLadderGate_ExplicitDimensionDisableWins', () => {
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D2: { severity: 'blocking', enabled: false } },
    });
    expect(resolveGateSeverity(LADDER_GATE, 'D2', config, 'oneshot')).toBe('disabled');
  });

  /** The table has no entry for a feature workflow. */
  it('ResolveGateSeverity_FeatureWorkflow_UnchangedResolution', () => {
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS, 'feature')).toBe('blocking');
  });

  it('ResolveGateSeverity_NoWorkflowType_UnchangedResolution', () => {
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS)).toBe('blocking');
  });
});
