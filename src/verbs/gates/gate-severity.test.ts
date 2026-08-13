import { describe, it, expect } from 'vitest';
import { resolveGateSeverity, WORKFLOW_DEFAULT_SEVERITY } from './gate-severity.js';
import { DEFAULTS } from '../../config/resolve.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../../workflow/verification-policy.js';

// Helper to create config with overrides
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

// ─── Per-workflow severity (oneshot → advisory for ladder gates) ─────────────
//
// Task 005: a verification-ladder gate that would otherwise be blocking
// resolves to `warning` when the workflow is `oneshot`, UNLESS the consumer
// pins it explicitly via `review.gates[gateName]`. The mapping is a data table
// (`WORKFLOW_DEFAULT_SEVERITY`) so future workflow types are additions, not
// branching code. A non-ladder gate, a non-oneshot workflow, and an omitted
// `workflowType` all resolve EXACTLY as before (legacy callers unaffected).

const LADDER_GATE = VERIFICATION_GATE_NAMES[0]; // 'check_static_analysis'

describe('resolveGateSeverity per-workflow severity', () => {
  it('WORKFLOW_DEFAULT_SEVERITY_OneshotEntry_IsWarning', () => {
    // The data table — not branching prose — drives the workflow default.
    expect(WORKFLOW_DEFAULT_SEVERITY.oneshot).toBe('warning');
  });

  it('ResolveGateSeverity_OneshotLadderGate_DefaultsToWarning', () => {
    // A ladder gate under an oneshot workflow downgrades blocking → warning by
    // default (no gate-level override present).
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS, 'oneshot')).toBe('warning');
  });

  it('ResolveGateSeverity_OneshotWithExplicitGateOverride_OverrideWins', () => {
    // An explicit `review.gates[gate]` blocking pin beats the oneshot default.
    const config = configWith({
      gates: { [LADDER_GATE]: { enabled: true, blocking: true, params: {} } },
    });
    expect(resolveGateSeverity(LADDER_GATE, 'D2', config, 'oneshot')).toBe('blocking');
  });

  it('ResolveGateSeverity_OneshotNonLadderGate_UnchangedResolution', () => {
    // A non-ladder gate name ignores the workflow default — stays blocking.
    expect(resolveGateSeverity('security-scan', 'D1', DEFAULTS, 'oneshot')).toBe('blocking');
  });

  it('ResolveGateSeverity_OneshotLadderGate_ExplicitDimensionDisableWins', () => {
    // An explicit `enabled: false` on the gate's dimension is a stronger
    // statement than the oneshot ladder default — the gate resolves to
    // 'disabled', NOT the warning the workflow default would otherwise apply.
    const config = configWith({
      dimensions: { ...DEFAULTS.review.dimensions, D2: { severity: 'blocking', enabled: false } },
    });
    expect(resolveGateSeverity(LADDER_GATE, 'D2', config, 'oneshot')).toBe('disabled');
  });

  it('ResolveGateSeverity_FeatureWorkflow_UnchangedResolution', () => {
    // A non-oneshot workflow has no default-severity table entry — unchanged.
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS, 'feature')).toBe('blocking');
  });

  it('ResolveGateSeverity_NoWorkflowType_UnchangedResolution', () => {
    // Omitting workflowType is exactly today's behavior (legacy callers).
    expect(resolveGateSeverity(LADDER_GATE, 'D2', DEFAULTS)).toBe('blocking');
  });
});
