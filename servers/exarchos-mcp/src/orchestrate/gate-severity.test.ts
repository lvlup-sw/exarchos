import { describe, it, expect } from 'vitest';
import { resolveGateSeverity } from './gate-severity.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';

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
