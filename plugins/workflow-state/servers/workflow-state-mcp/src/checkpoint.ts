import type { CheckpointState, CheckpointMeta } from './types.js';

// ─── Configurable Constants ────────────────────────────────────────────────

export const CHECKPOINT_OPERATION_THRESHOLD: number =
  parseInt(process.env.CHECKPOINT_OPERATION_THRESHOLD || '', 10) || 20;

export const STALE_AFTER_MINUTES: number =
  parseInt(process.env.STALE_AFTER_MINUTES || '', 10) || 120;

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
  const now = Date.now();
  const diffMs = now - lastActivity;
  return Math.floor(diffMs / (60 * 1000));
}

/** Build the _meta response block included in every tool response. */
export function buildCheckpointMeta(checkpoint: CheckpointState): CheckpointMeta {
  return {
    checkpointAdvised: isCheckpointAdvised(checkpoint),
    operationsSinceCheckpoint: checkpoint.operationsSince,
    lastCheckpointPhase: checkpoint.phase,
    lastCheckpointTimestamp: checkpoint.timestamp,
    stale: isStale(checkpoint),
    minutesSinceActivity: getMinutesSinceActivity(checkpoint),
  };
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
