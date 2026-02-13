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
}

/** A discovered workflow for the session-start response. */
interface WorkflowInfo {
  readonly featureId: string;
  readonly phase: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly tasks?: ReadonlyArray<{ id: string; status: string; title: string }>;
}

/** Result from the session-start command. */
export interface SessionStartResult extends CommandResult {
  readonly workflows?: ReadonlyArray<WorkflowInfo>;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

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
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
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
      const data = JSON.parse(raw) as CheckpointData;
      results.push(data);
      // Clean up the checkpoint file after successful read
      await fs.unlink(filePath);
    } catch {
      // Skip malformed checkpoint files — do not crash
      continue;
    }
  }

  return results;
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

    const workflows: WorkflowInfo[] = checkpoints.map((cp) => ({
      featureId: cp.featureId,
      phase: cp.phase,
      summary: cp.summary,
      nextAction: cp.nextAction,
      tasks: cp.tasks.length > 0 ? cp.tasks : undefined,
    }));

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
