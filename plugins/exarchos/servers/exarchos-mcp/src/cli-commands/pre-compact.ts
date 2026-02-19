import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { listStateFiles } from '../workflow/state-store.js';
import { PHASE_ACTION_MAP, HUMAN_CHECKPOINT_PHASES } from '../workflow/next-action.js';
import { handleAssembleContext } from './assemble-context.js';
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
  readonly teamState?: unknown;
  readonly contextFile?: string;
}

/** Result returned from the pre-compact handler. */
export interface PreCompactResult extends CommandResult {
  readonly continue: boolean;
  readonly stopReason?: string;
}

// ─── Terminal Phases ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);
const DELEGATE_PHASES = new Set(['delegate', 'overhaul-delegate']);

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
  stdinData: Record<string, unknown>,
  stateDir: string,
): Promise<PreCompactResult> {
  const trigger = typeof stdinData.type === 'string' ? stdinData.type : 'auto';

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

  // Checkpoint all active workflows in parallel — each workflow's I/O is independent
  await Promise.all(activeWorkflows.map(async ({ featureId, stateFile, state }) => {
    const tasks = (state.tasks ?? []).map((t) => ({
      id: t.id,
      status: t.status,
      title: t.title,
    }));

    const nextAction = computeNextAction(state.workflowType, state.phase);
    const summary = buildSummary(featureId, state.workflowType, state.phase, tasks);

    // Include team composition snapshot for delegate phases when teamState exists
    const stateRecord = state as unknown as Record<string, unknown>;
    const teamState =
      DELEGATE_PHASES.has(state.phase) && stateRecord.teamState != null
        ? stateRecord.teamState
        : undefined;

    // Generate context.md first so checkpoint can include the contextFile path in a single write
    let contextFile: string | undefined;
    try {
      const contextResult = await handleAssembleContext({ featureId }, stateDir);
      if (contextResult.contextDocument) {
        contextFile = path.join(stateDir, `${featureId}.context.md`);
        await fs.writeFile(contextFile, contextResult.contextDocument, 'utf-8');
      }
    } catch {
      // Graceful degradation — checkpoint works without context.md
    }

    const checkpoint: CheckpointData = {
      featureId,
      timestamp: new Date().toISOString(),
      phase: state.phase,
      summary,
      nextAction,
      tasks,
      artifacts: state.artifacts as Record<string, unknown>,
      stateFile,
      ...(teamState !== undefined && { teamState }),
      ...(contextFile !== undefined && { contextFile }),
    };

    const checkpointPath = path.join(stateDir, `${featureId}.checkpoint.json`);
    await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
  }));

  if (trigger === 'manual') {
    return { continue: true };
  }

  return {
    continue: false,
    stopReason: `Context checkpoint saved. Type /clear to reload with fresh context.`,
  };
}
