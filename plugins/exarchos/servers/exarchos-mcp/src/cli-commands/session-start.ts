import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandResult } from '../cli.js';
import { listStateFiles } from '../workflow/state-store.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Shape of a checkpoint file written by the pre-compact command. */
interface CheckpointData {
  readonly featureId: string;
  readonly timestamp: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks: ReadonlyArray<{ id: string; status: string; title: string }>;
  readonly artifacts: Record<string, unknown>;
  readonly stateFile: string;
  readonly teamState?: unknown;
}

/** Recovery info attached when orphaned team state is detected. */
interface RecoveryInfo {
  readonly type: string;
  readonly message: string;
  readonly completedTasks: number;
  readonly remainingTasks: number;
}

/** A discovered workflow for the session-start response. */
interface WorkflowInfo {
  readonly featureId: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks?: ReadonlyArray<{ id: string; status: string; title: string }>;
  readonly recovery?: RecoveryInfo;
}

/** Result from the session-start command. */
export interface SessionStartResult extends CommandResult {
  readonly workflows?: ReadonlyArray<WorkflowInfo>;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);
const DELEGATE_PHASES = new Set(['delegate', 'overhaul-delegate']);

// ─── Type Guard ──────────────────────────────────────────────────────────────

/** Validate that parsed JSON matches the CheckpointData shape before use. */
function isCheckpointData(value: unknown): value is CheckpointData {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.featureId === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.phase === 'string' &&
    typeof obj.summary === 'string' &&
    typeof obj.nextAction === 'string' &&
    Array.isArray(obj.tasks) &&
    typeof obj.stateFile === 'string'
  );
}

// ─── Checkpoint Reader ──────────────────────────────────────────────────────

/**
 * Scan the state directory for checkpoint files and return their data.
 * Each checkpoint is deleted after being read.
 */
async function readAndDeleteCheckpoints(stateDir: string): Promise<CheckpointData[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR') {
      return [];
    }
    throw err;
  }

  const checkpointFiles = entries.filter((f) => f.endsWith('.checkpoint.json'));
  const results: CheckpointData[] = [];

  for (const file of checkpointFiles) {
    const filePath = path.join(stateDir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isCheckpointData(parsed)) {
        // Skip invalid checkpoint — don't delete, don't crash
        continue;
      }
      // Delete BEFORE adding to results to ensure at-most-once delivery.
      // If unlink fails, the file stays on disk and is NOT added to results,
      // preventing duplicate processing on the next session start.
      await fs.unlink(filePath);
      results.push(parsed);
    } catch {
      // Skip malformed or undeletable checkpoint files — do not crash
      continue;
    }
  }

  return results;
}

// ─── Orphaned Team Detection ────────────────────────────────────────────────

/**
 * Detect orphaned team state from a checkpoint.
 * Returns recovery info if the checkpoint is in the delegate phase and has
 * active (non-completed) teammates. Returns undefined otherwise.
 */
function detectOrphanedTeam(
  checkpoint: CheckpointData,
): RecoveryInfo | undefined {
  if (!DELEGATE_PHASES.has(checkpoint.phase)) return undefined;
  if (!checkpoint.teamState || typeof checkpoint.teamState !== 'object') return undefined;

  const ts = checkpoint.teamState as Record<string, unknown>;
  const teammates = ts.teammates;
  if (!Array.isArray(teammates) || teammates.length === 0) return undefined;

  const activeTeammates = teammates.filter((t) => {
    if (!t || typeof t !== 'object') return false;
    const teammate = t as Record<string, unknown>;
    return teammate.status === 'active';
  });

  if (activeTeammates.length === 0) return undefined;

  const completedTasks = checkpoint.tasks.filter((t) => t.status === 'complete').length;
  const remainingTasks = checkpoint.tasks.length - completedTasks;

  return {
    type: 'orphaned_team',
    message: `${activeTeammates.length} active teammate(s) orphaned after compaction`,
    completedTasks,
    remainingTasks,
  };
}

// ─── Handler ────────────────────────────────────────────────────────────────

/**
 * Handle the `session-start` CLI command.
 *
 * Priority:
 * 1. If checkpoint files exist, return their resume context (and delete them).
 * 2. If no checkpoints, scan for active (non-terminal) workflow state files.
 * 3. If nothing found, return silently (no error, no workflows).
 */
export async function handleSessionStart(
  _stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<SessionStartResult> {
  // Step 1: Check for checkpoint files (highest priority)
  const checkpoints = await readAndDeleteCheckpoints(stateDir);

  if (checkpoints.length > 0) {
    // Collect featureIds from checkpoints to exclude from state file discovery
    const checkpointFeatureIds = new Set(checkpoints.map((cp) => cp.featureId));

    const workflows: WorkflowInfo[] = checkpoints.map((cp) => {
      const recovery = detectOrphanedTeam(cp);
      return {
        featureId: cp.featureId,
        phase: cp.phase,
        summary: cp.summary,
        nextAction: cp.nextAction,
        tasks: cp.tasks.length > 0 ? cp.tasks : undefined,
        ...(recovery !== undefined && { recovery }),
      };
    });

    // Also check for active state files not covered by checkpoints
    try {
      const stateFiles = await listStateFiles(stateDir);
      for (const entry of stateFiles) {
        if (checkpointFeatureIds.has(entry.featureId)) continue;
        if (TERMINAL_PHASES.has(entry.state.phase)) continue;

        workflows.push({
          featureId: entry.featureId,
          phase: entry.state.phase,
          summary: `Active workflow discovered (${entry.state.workflowType})`,
          nextAction: `WAIT:in-progress:${entry.state.phase}`,
        });
      }
    } catch {
      // Non-critical: if listing fails, we still have checkpoint data
    }

    return { workflows };
  }

  // Step 2: No checkpoints — discover active workflows from state files
  try {
    const stateFiles = await listStateFiles(stateDir);
    const activeWorkflows = stateFiles.filter(
      (entry) => !TERMINAL_PHASES.has(entry.state.phase),
    );

    if (activeWorkflows.length === 0) {
      // Silent: no active workflows
      return {};
    }

    const workflows: WorkflowInfo[] = activeWorkflows.map((entry) => ({
      featureId: entry.featureId,
      phase: entry.state.phase,
      summary: `Active workflow discovered (${entry.state.workflowType})`,
      nextAction: `WAIT:in-progress:${entry.state.phase}`,
    }));

    return { workflows };
  } catch {
    // If state dir doesn't exist or is unreadable, silent return
    return {};
  }
}
