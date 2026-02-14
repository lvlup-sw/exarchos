import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listStateFiles } from '../workflow/state-store.js';
import { PHASE_ACTION_MAP, HUMAN_CHECKPOINT_PHASES } from '../workflow/next-action.js';
import type { CommandResult } from '../cli.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Checkpoint file written alongside each active workflow state file. */
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

/** Result returned from the pre-compact handler. */
export interface PreCompactResult extends CommandResult {
  readonly continue: boolean;
  readonly stopReason?: string;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

// ─── Inline Next-Action Computation ─────────────────────────────────────────

/**
 * Compute a simplified next action from state, without requiring EventStore.
 * Mirrors the logic in next-action.ts but skips guard evaluation and
 * circuit breaker checks (not available without event store).
 */
function computeNextAction(workflowType: string, phase: string): string {
  // Check human checkpoint phases first
  const humanCheckpoints = HUMAN_CHECKPOINT_PHASES[workflowType];
  if (humanCheckpoints?.has(phase)) {
    return `WAIT:human-checkpoint:${phase}`;
  }

  // Look up phase-to-action map
  const actionMap = PHASE_ACTION_MAP[workflowType];
  const action = actionMap?.[phase];
  if (action) {
    return action;
  }

  // Fallback: in progress
  return `WAIT:in-progress:${phase}`;
}

// ─── Summary Builder ────────────────────────────────────────────────────────

function buildSummary(
  featureId: string,
  workflowType: string,
  phase: string,
  tasks: ReadonlyArray<{ id: string; status: string; title: string }>,
): string {
  const completed = tasks.filter((t) => t.status === 'complete').length;
  const total = tasks.length;
  const taskProgress = total > 0 ? `${completed}/${total} tasks complete` : 'no tasks';

  return `[${workflowType}] ${featureId}: phase=${phase}, ${taskProgress}`;
}

// ─── Pre-Compact Handler ────────────────────────────────────────────────────

/**
 * Scan the state directory for active workflows, write checkpoint files,
 * and return whether compaction should proceed.
 */
export async function handlePreCompact(
  _stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<PreCompactResult> {
  // List all state files (listStateFiles handles missing directory gracefully)
  const allWorkflows = await listStateFiles(stateDir);

  // Filter to active (non-terminal) workflows
  const activeWorkflows = allWorkflows.filter(
    (wf) => !TERMINAL_PHASES.has(wf.state.phase),
  );

  // No active workflows: allow compaction
  if (activeWorkflows.length === 0) {
    return { continue: true };
  }

  // Checkpoint each active workflow
  for (const { featureId, stateFile, state } of activeWorkflows) {
    const tasks = (state.tasks ?? []).map((t) => ({
      id: t.id,
      status: t.status,
      title: t.title,
    }));

    const nextAction = computeNextAction(state.workflowType, state.phase);
    const summary = buildSummary(featureId, state.workflowType, state.phase, tasks);

    const checkpoint: CheckpointData = {
      featureId,
      timestamp: new Date().toISOString(),
      phase: state.phase,
      summary,
      nextAction,
      tasks,
      artifacts: state.artifacts as Record<string, unknown>,
      stateFile,
    };

    const checkpointPath = path.join(stateDir, `${featureId}.checkpoint.json`);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }

  return {
    continue: false,
    stopReason: `Checkpoint saved for ${activeWorkflows.length} workflow(s). Run /resume to continue.`,
  };
}
