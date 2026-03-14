import { describe, it, expect, vi } from 'vitest';
import { withConfigSeverity } from './gate-utils.js';
import { DEFAULTS } from '../config/resolve.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { ToolResult } from '../format.js';

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
});
