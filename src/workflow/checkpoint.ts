import type { CheckpointState, CheckpointMeta } from './types.js';

export const CHECKPOINT_OPERATION_THRESHOLD: number = Math.max(
  1,
  parseInt(process.env.CHECKPOINT_OPERATION_THRESHOLD || '', 10) || 20,
);

export const STALE_AFTER_MINUTES: number = Math.max(
  1,
  parseInt(process.env.STALE_AFTER_MINUTES || '', 10) || 120,
);

/** Return a copy of the checkpoint with the operation counter incremented. */
export function incrementOperations(checkpoint: CheckpointState): CheckpointState {
  const now = new Date().toISOString();
  return {
    ...checkpoint,
    operationsSince: checkpoint.operationsSince + 1,
    lastActivityTimestamp: now,
  };
}

/** Tell if the operation count reached the checkpoint threshold. */
export function isCheckpointAdvised(checkpoint: CheckpointState): boolean {
  return checkpoint.operationsSince >= CHECKPOINT_OPERATION_THRESHOLD;
}

/** Reset the counter on a phase transition or an explicit checkpoint. */
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

/** Tell if the time since the last activity is more than `staleAfterMinutes`. */
export function isStale(checkpoint: CheckpointState): boolean {
  const minutesSince = getMinutesSinceActivity(checkpoint);
  return minutesSince > checkpoint.staleAfterMinutes;
}

/** Whole minutes since the last activity. An unreadable timestamp gives 0. */
export function getMinutesSinceActivity(checkpoint: CheckpointState): number {
  const lastActivity = new Date(checkpoint.lastActivityTimestamp).getTime();
  if (Number.isNaN(lastActivity)) return 0;
  const now = Date.now();
  const diffMs = Math.max(0, now - lastActivity);
  return Math.floor(diffMs / (60 * 1000));
}

/**
 * Build the `_meta` block for each tool response. The block is slim when no
 * checkpoint is advised and the workflow is not stale.
 */
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
 * Tell if the checkpoint gate blocks the current action. The gate blocks when
 * `operationsSince` reaches `operationThreshold`. A missing checkpoint does not block
 * and gives a warning. The config can turn off the gate for each action type.
 */
export function shouldEnforceCheckpoint(
  checkpoint: CheckpointState | undefined | null,
  config: CheckpointEnforcementConfig,
  actionType: 'phase-transition' | 'wave-dispatch',
): CheckpointGateResult {
  if (checkpoint == null) {
    return { gated: false, warning: 'checkpoint-state-missing' };
  }

  if (actionType === 'phase-transition' && !config.enforceOnPhaseTransition) {
    return { gated: false };
  }
  if (actionType === 'wave-dispatch' && !config.enforceOnWaveDispatch) {
    return { gated: false };
  }

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

/** Create the initial checkpoint state for a new workflow. */
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
