import { describe, it, expect, vi } from 'vitest';
import { withConfigSeverity, applyLadderGateSeverity } from './gates/gate-utils.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { ToolResult } from '../format.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';

describe('withConfigSeverity', () => {
  const mockGateHandler = vi.fn<() => Promise<ToolResult>>();

  it('GateHandler_DisabledGate_SkipsExecution', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      review: {
        ...DEFAULTS.review,
        gates: { 'test-gate': { enabled: false, blocking: true, params: {} } },
      },
    };

    const result = await withConfigSeverity('test-gate', 'D1', config, mockGateHandler);
    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).skipped).toBe(true);
    expect(mockGateHandler).not.toHaveBeenCalled();
  });

  it('GateHandler_WarningGate_ExecutesButDoesNotBlock', async () => {
    const config: ResolvedProjectConfig = {
      ...DEFAULTS,
      review: {
        ...DEFAULTS.review,
        gates: { 'test-gate': { enabled: true, blocking: false, params: {} } },
      },
    };

    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity('test-gate', 'D1', config, mockGateHandler);
    expect(result.success).toBe(true); // warning gates don't block
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('warning-only')]));
    expect(mockGateHandler).toHaveBeenCalled();
  });

  it('GateHandler_BlockingGate_FailureBlocks', async () => {
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity('test-gate', 'D1', DEFAULTS, mockGateHandler);
    expect(result.success).toBe(false); // blocking gates fail
  });

  it('GateHandler_NoProjectConfig_DefaultBehavior', async () => {
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity('test-gate', 'D1', undefined, mockGateHandler);
    expect(result.success).toBe(false); // no config = all blocking
    expect(mockGateHandler).toHaveBeenCalled();
  });

  it('GateHandler_BlockingGate_PassStillPasses', async () => {
    mockGateHandler.mockResolvedValue({
      success: true,
      data: { passed: true },
    });

    const result = await withConfigSeverity('test-gate', 'D1', DEFAULTS, mockGateHandler);
    expect(result.success).toBe(true);
  });

  it('GateHandler_OneshotLadderGate_FailureBecomesWarning', async () => {
    // Task 005: a ladder-gate failure under an oneshot workflow is threaded as
    // warning severity via the new trailing workflowType param — the failure is
    // converted to success-with-warning rather than blocking.
    const ladderGate = VERIFICATION_GATE_NAMES[0]; // 'check_static_analysis'
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity(ladderGate, 'D2', DEFAULTS, mockGateHandler, 'oneshot');
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('warning-only')]),
    );
  });

  it('GateHandler_FeatureLadderGate_FailureStillBlocks', async () => {
    // A non-oneshot workflow keeps the ladder gate blocking (no table entry).
    const ladderGate = VERIFICATION_GATE_NAMES[0];
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity(ladderGate, 'D2', DEFAULTS, mockGateHandler, 'feature');
    expect(result.success).toBe(false);
  });
});

// ─── applyLadderGateSeverity (advisory-carrier conversion) ───────────────────
//
// Ladder gates are INV-5b advisory carriers: a FAILING gate is
// `success:true, data.passed:false`, NOT `success:false`. This helper applies
// the resolved per-workflow severity to that advisory shape — converting a
// `data.passed:false` to success-with-warning when severity is `warning`,
// leaving the result untouched otherwise.

const LADDER = VERIFICATION_GATE_NAMES[0]; // 'check_static_analysis'

describe('applyLadderGateSeverity', () => {
  it('ApplyLadderGateSeverity_OneshotFailingAdvisory_AddsWarning', () => {
    const advisory: ToolResult = { success: true, data: { passed: false, report: 'r' } };
    const result = applyLadderGateSeverity(LADDER, 'D2', DEFAULTS, advisory, 'oneshot');
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('warning-only')]),
    );
  });

  it('ApplyLadderGateSeverity_OneshotPassingAdvisory_Unchanged', () => {
    const advisory: ToolResult = { success: true, data: { passed: true } };
    const result = applyLadderGateSeverity(LADDER, 'D2', DEFAULTS, advisory, 'oneshot');
    expect(result).toEqual(advisory);
    expect(result.warnings).toBeUndefined();
  });

  it('ApplyLadderGateSeverity_FeatureFailingAdvisory_Unchanged', () => {
    // Blocking severity (no oneshot table entry) leaves the advisory result as
    // the handler returned it — the orchestrator reads data.passed to block.
    const advisory: ToolResult = { success: true, data: { passed: false } };
    const result = applyLadderGateSeverity(LADDER, 'D2', DEFAULTS, advisory, 'feature');
    expect(result).toEqual(advisory);
    expect(result.warnings).toBeUndefined();
  });

  it('ApplyLadderGateSeverity_NoConfig_Unchanged', () => {
    const advisory: ToolResult = { success: true, data: { passed: false } };
    const result = applyLadderGateSeverity(LADDER, 'D2', undefined, advisory, 'oneshot');
    expect(result).toEqual(advisory);
  });

  it('ApplyLadderGateSeverity_ErrorResult_Untouched', () => {
    // A real error envelope (not an advisory carrier) is never downgraded — an
    // INVALID_INPUT / MISWIRED_CONTEXT must still surface as a failure.
    const errored: ToolResult = {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
    const result = applyLadderGateSeverity(LADDER, 'D2', DEFAULTS, errored, 'oneshot');
    expect(result).toEqual(errored);
  });
});
