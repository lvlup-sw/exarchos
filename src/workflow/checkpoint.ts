import type { CheckpointState, CheckpointMeta } from './types.js';

// ─── Configurable Constants ────────────────────────────────────────────────

export const CHECKPOINT_OPERATION_THRESHOLD: number = Math.max(
  1,
  parseInt(process.env.CHECKPOINT_OPERATION_THRESHOLD || '', 10) || 20,
);

export const STALE_AFTER_MINUTES: number = Math.max(
  1,
  parseInt(process.env.STALE_AFTER_MINUTES || '', 10) || 120,
);

// ─── Checkpoint Functions ──────────────────────────────────────────────────

/** Increment operation counter, return updated checkpoint state (immutable). */
export function incrementOperations(checkpoint: CheckpointState): CheckpointState {
  const now = new Date().toISOString();
  return {
    ...checkpoint,
    operationsSince: checkpoint.operationsSince + 1,
    lastActivityTimestamp: now,
  };
}

/** Check if checkpoint is advised based on operation threshold. */
export function isCheckpointAdvised(checkpoint: CheckpointState): boolean {
  return checkpoint.operationsSince >= CHECKPOINT_OPERATION_THRESHOLD;
}

/**
 * Reset counter on phase transition or explicit checkpoint.
 * Updates timestamp, phase, summary, and resets operationsSince to 0.
 */
export function resetCounter(
  checkpoint: CheckpointState,
  phase: string,
  summary?: string,
): CheckpointState {
  const now = new Date().toISOString();
  return {
    ...checkpoint,
    timestamp: now,
    lastActivityTimestamp: now,
    phase,
    summary: summary ?? `Phase transition to ${phase}`,
    operationsSince: 0,
  };
}

/** Detect staleness: returns true if time since last activity exceeds staleAfterMinutes. */
export function isStale(checkpoint: CheckpointState): boolean {
  const minutesSince = getMinutesSinceActivity(checkpoint);
  return minutesSince > checkpoint.staleAfterMinutes;
}

/** Get minutes since last activity (rounded down). */
export function getMinutesSinceActivity(checkpoint: CheckpointState): number {
  const lastActivity = new Date(checkpoint.lastActivityTimestamp).getTime();
  if (Number.isNaN(lastActivity)) return 0;
  const now = Date.now();
  const diffMs = Math.max(0, now - lastActivity);
  return Math.floor(diffMs / (60 * 1000));
}

/** Build the _meta response block included in every tool response.
 *  Returns slim shape when no action needed, full shape when checkpoint or staleness attention required. */
export function buildCheckpointMeta(checkpoint: CheckpointState): CheckpointMeta {
  const advised = isCheckpointAdvised(checkpoint);
  const stale = isStale(checkpoint);

  if (!advised && !stale) {
    return { checkpointAdvised: false };
  }

  return {
    checkpointAdvised: advised,
    operationsSinceCheckpoint: checkpoint.operationsSince,
    lastCheckpointPhase: checkpoint.phase,
    lastCheckpointTimestamp: checkpoint.timestamp,
    stale,
    minutesSinceActivity: getMinutesSinceActivity(checkpoint),
  };
}

// ─── Checkpoint Gate (DR-5, DR-10) ────────────────────────────────────────

export interface CheckpointGateResult {
  gated: boolean;
  gate?: 'checkpoint_required';
  operationsSince?: number;
  threshold?: number;
  warning?: string;
}

export interface CheckpointEnforcementConfig {
  operationThreshold: number;
  enforceOnPhaseTransition: boolean;
  enforceOnWaveDispatch: boolean;
}

/**
 * Evaluate whether a checkpoint gate should block the current action.
 *
 * - Nullish checkpoint state: graceful degradation (DR-10) — returns not-gated with warning.
 * - Action-type enforcement toggles: config can disable gate per action type.
 * - Threshold comparison: operationsSince >= operationThreshold triggers the gate.
 */
export function shouldEnforceCheckpoint(
  checkpoint: CheckpointState | undefined | null,
  config: CheckpointEnforcementConfig,
  actionType: 'phase-transition' | 'wave-dispatch',
): CheckpointGateResult {
  // DR-10: graceful degradation when checkpoint state is missing
  if (checkpoint == null) {
    return { gated: false, warning: 'checkpoint-state-missing' };
  }

  // Check action-type enforcement toggles
  if (actionType === 'phase-transition' && !config.enforceOnPhaseTransition) {
    return { gated: false };
  }
  if (actionType === 'wave-dispatch' && !config.enforceOnWaveDispatch) {
    return { gated: false };
  }

  // Threshold comparison
  if (checkpoint.operationsSince >= config.operationThreshold) {
    return {
      gated: true,
      gate: 'checkpoint_required',
      operationsSince: checkpoint.operationsSince,
      threshold: config.operationThreshold,
    };
  }

  return { gated: false };
}

/** Create initial checkpoint state for new workflows. */
export function createInitialCheckpoint(phase: string): CheckpointState {
  const now = new Date().toISOString();
  return {
    timestamp: now,
    phase,
    summary: `Workflow initialized at ${phase}`,
    operationsSince: 0,
    fixCycleCount: 0,
    lastActivityTimestamp: now,
    staleAfterMinutes: STALE_AFTER_MINUTES,
  };
}
