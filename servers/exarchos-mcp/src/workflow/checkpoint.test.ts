import { describe, it, expect } from 'vitest';
import type { CheckpointState } from './types.js';
import {
  shouldEnforceCheckpoint,
  type CheckpointEnforcementConfig,
  type CheckpointGateResult,
} from './checkpoint.js';

// ─── shouldEnforceCheckpoint ─────────────────────────────────────────────────

describe('shouldEnforceCheckpoint', () => {
  const defaultConfig: CheckpointEnforcementConfig = {
    operationThreshold: 20,
    enforceOnPhaseTransition: true,
    enforceOnWaveDispatch: true,
  };

  function makeCheckpoint(overrides: Partial<CheckpointState> = {}): CheckpointState {
    return {
      timestamp: '2026-01-01T00:00:00Z',
      phase: 'implement',
      summary: 'Test checkpoint',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '2026-01-01T00:00:00Z',
      staleAfterMinutes: 120,
      ...overrides,
    };
  }

  it('shouldEnforceCheckpoint_AboveThreshold_ReturnsGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(true);
    expect(result.gate).toBe('checkpoint_required');
    expect(result.operationsSince).toBe(25);
    expect(result.threshold).toBe(20);
  });

  it('shouldEnforceCheckpoint_BelowThreshold_ReturnsNotGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 10 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
    expect(result.operationsSince).toBeUndefined();
    expect(result.threshold).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_MissingState_ReturnsNotGatedWithWarning', () => {
    const resultUndefined = shouldEnforceCheckpoint(undefined, defaultConfig, 'phase-transition');
    expect(resultUndefined.gated).toBe(false);
    expect(resultUndefined.warning).toBe('checkpoint-state-missing');

    const resultNull = shouldEnforceCheckpoint(null, defaultConfig, 'phase-transition');
    expect(resultNull.gated).toBe(false);
    expect(resultNull.warning).toBe('checkpoint-state-missing');
  });

  it('shouldEnforceCheckpoint_PhaseTransitionDisabled_SkipsCheck', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const config: CheckpointEnforcementConfig = {
      ...defaultConfig,
      enforceOnPhaseTransition: false,
    };
    const result = shouldEnforceCheckpoint(checkpoint, config, 'phase-transition');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_WaveDispatchDisabled_SkipsCheck', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 25 });
    const config: CheckpointEnforcementConfig = {
      ...defaultConfig,
      enforceOnWaveDispatch: false,
    };
    const result = shouldEnforceCheckpoint(checkpoint, config, 'wave-dispatch');

    expect(result.gated).toBe(false);
    expect(result.gate).toBeUndefined();
  });

  it('shouldEnforceCheckpoint_ExactThreshold_ReturnsGated', () => {
    const checkpoint = makeCheckpoint({ operationsSince: 20 });
    const result = shouldEnforceCheckpoint(checkpoint, defaultConfig, 'phase-transition');

    expect(result.gated).toBe(true);
    expect(result.gate).toBe('checkpoint_required');
    expect(result.operationsSince).toBe(20);
    expect(result.threshold).toBe(20);
  });

  // ─── Config wiring (Task 019) ──────────────────────────────────────────────

  it('shouldEnforceCheckpoint_ConfiguredThreshold30_UsesConfigValue', () => {
    const config: CheckpointEnforcementConfig = {
      operationThreshold: 30,
      enforceOnPhaseTransition: true,
      enforceOnWaveDispatch: true,
    };

    // 25 ops — below custom threshold of 30 → not gated
    const checkpointBelow = makeCheckpoint({ operationsSince: 25 });
    const resultBelow = shouldEnforceCheckpoint(checkpointBelow, config, 'phase-transition');
    expect(resultBelow.gated).toBe(false);

    // 35 ops — above custom threshold of 30 → gated
    const checkpointAbove = makeCheckpoint({ operationsSince: 35 });
    const resultAbove = shouldEnforceCheckpoint(checkpointAbove, config, 'phase-transition');
    expect(resultAbove.gated).toBe(true);
    expect(resultAbove.threshold).toBe(30);
    expect(resultAbove.operationsSince).toBe(35);
  });

  it('shouldEnforceCheckpoint_ConfigDisablesPhaseTransition_SkipsGate', () => {
    const config: CheckpointEnforcementConfig = {
      operationThreshold: 20,
      enforceOnPhaseTransition: false,
      enforceOnWaveDispatch: true,
    };

    // Way above threshold but phase transition enforcement is disabled
    const checkpoint = makeCheckpoint({ operationsSince: 100 });
    const result = shouldEnforceCheckpoint(checkpoint, config, 'phase-transition');
    expect(result.gated).toBe(false);
  });
});
