import { describe, it, expect, vi } from 'vitest';
import { withConfigSeverity, applyLadderGateSeverity } from '../../../src/verbs/gates/gate-utils.js';
import { DEFAULTS } from '../../../src/config/resolve.js';
import type { ResolvedProjectConfig } from '../../../src/config/resolve.js';
import type { ToolResult } from '../../../src/format.js';
import { VERIFICATION_GATE_NAMES } from '../../../src/workflow/verification-policy.js';

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
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('warning-only')]));
    expect(mockGateHandler).toHaveBeenCalled();
  });

  it('GateHandler_BlockingGate_FailureBlocks', async () => {
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity('test-gate', 'D1', DEFAULTS, mockGateHandler);
    expect(result.success).toBe(false);
  });

  it('GateHandler_NoProjectConfig_DefaultBehavior', async () => {
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity('test-gate', 'D1', undefined, mockGateHandler);
    expect(result.success).toBe(false);
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

  /** Under a oneshot workflow, a ladder gate has warning severity, so a failure becomes success with a warning. */
  it('GateHandler_OneshotLadderGate_FailureBecomesWarning', async () => {
    const ladderGate = VERIFICATION_GATE_NAMES[0];
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

  /** A feature workflow has no severity entry for the ladder gate, so the gate stays blocking. */
  it('GateHandler_FeatureLadderGate_FailureStillBlocks', async () => {
    const ladderGate = VERIFICATION_GATE_NAMES[0];
    mockGateHandler.mockResolvedValue({
      success: false,
      error: { code: 'GATE_FAILED', message: 'Gate failed' },
    });

    const result = await withConfigSeverity(ladderGate, 'D2', DEFAULTS, mockGateHandler, 'feature');
    expect(result.success).toBe(false);
  });
});

/** The first ladder gate, `check_static_analysis`. */
const LADDER = VERIFICATION_GATE_NAMES[0];

/**
 * A failing ladder gate returns `success: true` with `data.passed: false`.
 * Under warning severity, the helper sets `data.passed` to true and adds a warning.
 * Otherwise it returns the result unchanged.
 */
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

  /** Blocking severity returns the result unchanged. The orchestrator reads `data.passed` to block. */
  it('ApplyLadderGateSeverity_FeatureFailingAdvisory_Unchanged', () => {
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

  /** An error result stays a failure, even under oneshot warning severity. */
  it('ApplyLadderGateSeverity_ErrorResult_Untouched', () => {
    const errored: ToolResult = {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
    const result = applyLadderGateSeverity(LADDER, 'D2', DEFAULTS, errored, 'oneshot');
    expect(result).toEqual(errored);
  });
});
