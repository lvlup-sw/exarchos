import { execFileSync } from 'child_process';
import { appendEvent } from './events.js';
import { ErrorCode } from './schemas.js';
import type { Event } from './types.js';

// ─── Command Execution Helper ─────────────────────────────────────────────────

const COMMAND_TIMEOUT_MS = 30_000;

function runCommand(cmd: string, args: readonly string[], options: CompensationOptions): void {
  execFileSync(cmd, args, {
    stdio: 'pipe',
    cwd: options.stateDir ?? process.cwd(),
    timeout: COMMAND_TIMEOUT_MS,
  });
}

// ─── Compensation Interfaces ─────────────────────────────────────────────────

export interface CompensationAction {
  readonly id: string;
  readonly phase: string;
  readonly description: string;
  execute: (
    state: Record<string, unknown>,
    options: CompensationOptions,
  ) => Promise<CompensationActionResult>;
}

export interface CompensationOptions {
  readonly dryRun: boolean;
  readonly stateDir?: string;
}

export interface CompensationActionResult {
  readonly actionId: string;
  readonly status: 'executed' | 'skipped' | 'failed' | 'dry-run';
  readonly message: string;
}

export interface CompensationResult {
  readonly actions: readonly CompensationActionResult[];
  readonly events: readonly Event[];
  readonly success: boolean;
  readonly errorCode?: string;
}

// ─── Phase Order (reverse compensation order) ───────────────────────────────

const PHASE_ORDER: readonly string[] = [
  'ideate',
  'plan',
  'delegate',
  'integrate',
  'review',
  'synthesize',
];

// ─── Compensation Action Registry ───────────────────────────────────────────

function createClosePrAction(): CompensationAction {
  return {
    id: 'synthesize:close-pr',
    phase: 'synthesize',
    description: 'Close the pull request if it exists',
    async execute(state, options) {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      const prUrl = synthesis?.prUrl as string | null | undefined;

      if (!prUrl) {
        return { actionId: 'synthesize:close-pr', status: 'skipped', message: 'No PR to close' };
      }

      if (options.dryRun) {
        return {
          actionId: 'synthesize:close-pr',
          status: 'dry-run',
          message: `Would close PR: ${prUrl}`,
        };
      }

      try {
        runCommand('gh', ['pr', 'close', prUrl, '--comment', 'Cancelled via compensation'], options);
        return { actionId: 'synthesize:close-pr', status: 'executed', message: `Closed PR: ${prUrl}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { actionId: 'synthesize:close-pr', status: 'failed', message: `Failed to close PR: ${msg}` };
      }
    },
  };
}

function createDeleteIntegrationBranchAction(): CompensationAction {
  return {
    id: 'integrate:delete-integration-branch',
    phase: 'integrate',
    description: 'Delete the integration branch if it exists',
    async execute(state, options) {
      const synthesis = state.synthesis as Record<string, unknown> | undefined;
      const branch = synthesis?.integrationBranch as string | null | undefined;

      if (!branch) {
        return {
          actionId: 'integrate:delete-integration-branch',
          status: 'skipped',
          message: 'No integration branch to delete',
        };
      }

      if (options.dryRun) {
        return {
          actionId: 'integrate:delete-integration-branch',
          status: 'dry-run',
          message: `Would delete branch: ${branch}`,
        };
      }

      try {
        // Delete local branch (ignore failure if doesn't exist)
        try {
          runCommand('git', ['branch', '-D', branch], options);
        } catch {
          // Ignore local branch delete failure
        }
        // Delete remote branch (ignore failure if doesn't exist)
        try {
          runCommand('git', ['push', 'origin', '--delete', branch], options);
        } catch {
          // Ignore remote delete failure
        }
        return {
          actionId: 'integrate:delete-integration-branch',
          status: 'executed',
          message: `Deleted integration branch: ${branch}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'integrate:delete-integration-branch',
          status: 'failed',
          message: `Failed to delete integration branch: ${msg}`,
        };
      }
    },
  };
}

function createCleanupWorktreesAction(): CompensationAction {
  return {
    id: 'delegate:cleanup-worktrees',
    phase: 'delegate',
    description: 'Remove worktrees created during delegation',
    async execute(state, options) {
      const worktrees = state.worktrees as Record<string, Record<string, unknown>> | undefined;

      if (!worktrees || Object.keys(worktrees).length === 0) {
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'skipped',
          message: 'No worktrees to clean up',
        };
      }

      if (options.dryRun) {
        const branches = Object.values(worktrees).map((w) => w.branch as string);
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'dry-run',
          message: `Would remove worktrees for branches: ${branches.join(', ')}`,
        };
      }

      try {
        for (const worktree of Object.values(worktrees)) {
          const worktreePath = worktree.path as string;
          try {
            runCommand('git', ['worktree', 'remove', worktreePath, '--force'], options);
          } catch {
            // Worktree may already be removed; continue
          }
        }
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'executed',
          message: `Cleaned up ${Object.keys(worktrees).length} worktree(s)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:cleanup-worktrees',
          status: 'failed',
          message: `Failed to clean up worktrees: ${msg}`,
        };
      }
    },
  };
}

function createDeleteFeatureBranchesAction(): CompensationAction {
  return {
    id: 'delegate:delete-feature-branches',
    phase: 'delegate',
    description: 'Delete feature branches created during delegation',
    async execute(state, options) {
      const tasks = state.tasks as Array<Record<string, unknown>> | undefined;
      const branches = (tasks ?? [])
        .map((t) => t.branch as string | undefined)
        .filter((b): b is string => !!b);

      if (branches.length === 0) {
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'skipped',
          message: 'No feature branches to delete',
        };
      }

      if (options.dryRun) {
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'dry-run',
          message: `Would delete branches: ${branches.join(', ')}`,
        };
      }

      try {
        for (const branch of branches) {
          // Delete local branch (ignore failure if doesn't exist)
          try {
            runCommand('git', ['branch', '-D', branch], options);
          } catch {
            // Ignore local delete failure
          }
          // Delete remote branch (ignore failure if doesn't exist)
          try {
            runCommand('git', ['push', 'origin', '--delete', branch], options);
          } catch {
            // Ignore remote delete failure
          }
        }
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'executed',
          message: `Deleted ${branches.length} feature branch(es)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          actionId: 'delegate:delete-feature-branches',
          status: 'failed',
          message: `Failed to delete feature branches: ${msg}`,
        };
      }
    },
  };
}

// ─── Action Registry ─────────────────────────────────────────────────────────

function getCompensationActions(): readonly CompensationAction[] {
  return [
    createClosePrAction(),
    createDeleteIntegrationBranchAction(),
    createCleanupWorktreesAction(),
    createDeleteFeatureBranchesAction(),
  ];
}

// ─── Executor ────────────────────────────────────────────────────────────────

function getPhasesInReverseOrder(currentPhase: string): string[] {
  const idx = PHASE_ORDER.indexOf(currentPhase);
  if (idx === -1) {
    // If phase not in order, include all phases in reverse
    return [...PHASE_ORDER].reverse();
  }
  // Include current phase and all phases before it, in reverse
  return PHASE_ORDER.slice(0, idx + 1).reverse();
}

export async function executeCompensation(
  state: Record<string, unknown>,
  currentPhase: string,
  events: readonly Event[],
  eventSequence: number,
  options: CompensationOptions,
): Promise<CompensationResult> {
  const phasesInOrder = getPhasesInReverseOrder(currentPhase);
  const allActions = getCompensationActions();

  // Order actions by reverse phase order
  const orderedActions: CompensationAction[] = [];
  for (const phase of phasesInOrder) {
    for (const action of allActions) {
      if (action.phase === phase) {
        orderedActions.push(action);
      }
    }
  }

  const results: CompensationActionResult[] = [];
  const compensationEvents: Event[] = [];
  let currentSequence = eventSequence;
  let hasFailure = false;

  for (const action of orderedActions) {
    const result = await action.execute(state, options);
    results.push(result);

    if (result.status === 'failed') {
      hasFailure = true;
    }

    // Log a compensation event for each action
    const { eventSequence: nextSeq, event } = appendEvent(
      [...events, ...compensationEvents],
      currentSequence,
      'compensation',
      `compensation:${action.id}`,
      {
        metadata: {
          actionId: result.actionId,
          status: result.status,
          message: result.message,
        },
      },
    );

    compensationEvents.push(event);
    currentSequence = nextSeq;
  }

  return {
    actions: results,
    events: compensationEvents,
    success: !hasFailure,
    ...(hasFailure && { errorCode: ErrorCode.COMPENSATION_PARTIAL }),
  };
}
