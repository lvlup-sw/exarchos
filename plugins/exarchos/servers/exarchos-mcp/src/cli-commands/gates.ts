// ─── Quality Gate CLI Commands ──────────────────────────────────────────────
//
// Gates run at task/teammate lifecycle boundaries to enforce quality standards.
// They execute configurable checks in the task's working directory.
//
// Exit semantics (managed by the CLI framework, not this module):
//   - continue: true  → exit 0 (gate passed, allow continuation)
//   - error returned   → exit 2 (gate blocked, feedback on stderr)

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CommandResult } from '../cli.js';

// ─── Check Definitions ─────────────────────────────────────────────────────

interface QualityCheck {
  readonly name: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly failureLabel: string;
}

const QUALITY_CHECKS: readonly QualityCheck[] = [
  {
    name: 'typecheck',
    command: 'npm run typecheck',
    timeoutMs: 30_000,
    failureLabel: 'typecheck failed',
  },
  {
    name: 'test',
    command: 'npm run test:run',
    timeoutMs: 120_000,
    failureLabel: 'tests failed',
  },
  {
    name: 'clean-worktree',
    command: 'git status --porcelain',
    timeoutMs: 10_000,
    failureLabel: 'uncommitted changes detected',
  },
];

// ─── Core Quality Check Runner ─────────────────────────────────────────────

/**
 * Run all quality checks sequentially in the given working directory.
 * Stops at the first failure and returns a GATE_FAILED error.
 * Returns `{ continue: true }` when all checks pass.
 */
export async function runQualityChecks(cwd: string): Promise<CommandResult> {
  for (const check of QUALITY_CHECKS) {
    try {
      const output = execSync(check.command, {
        cwd,
        timeout: check.timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'buffer',
      });

      // Special case: git status --porcelain returns empty when clean
      if (check.name === 'clean-worktree') {
        const statusOutput = output.toString('utf-8').trim();
        if (statusOutput.length > 0) {
          return {
            error: {
              code: 'GATE_FAILED',
              message: `${check.failureLabel}:\n${statusOutput}`,
            },
          };
        }
      }
    } catch (err: unknown) {
      const stderr = extractStderr(err);
      const stdout = extractStdout(err);
      const detail = stderr || stdout || (err instanceof Error ? err.message : String(err));

      return {
        error: {
          code: 'GATE_FAILED',
          message: `${check.failureLabel}:\n${detail}`,
        },
      };
    }
  }

  return { continue: true };
}

// ─── Input Validation ──────────────────────────────────────────────────────

function validateCwd(input: Record<string, unknown>): CommandResult | null {
  if (typeof input.cwd !== 'string' || input.cwd.length === 0) {
    return {
      error: {
        code: 'INVALID_INPUT',
        message: 'Missing required field: cwd',
      },
    };
  }
  return null;
}

// ─── Workflow State Types ───────────────────────────────────────────────────

interface WorkflowTask {
  readonly id: string;
  readonly title: string;
  status: string;
  readonly branch: string;
  completedAt?: string;
  readonly startedAt?: string;
  readonly blockedBy?: string[];
}

interface WorkflowWorktree {
  readonly branch: string;
  readonly status: string;
  readonly taskId: string;
  readonly path: string;
}

interface WorkflowState {
  readonly featureId: string;
  readonly phase: string;
  tasks: WorkflowTask[];
  worktrees: Record<string, WorkflowWorktree>;
  _version: number;
  [key: string]: unknown;
}

interface ActiveWorkflowResult {
  readonly featureId: string;
  readonly filePath: string;
  readonly state: WorkflowState;
}

const TERMINAL_PHASES = new Set(['completed', 'cancelled']);

// ─── Active Workflow Discovery ─────────────────────────────────────────────

/**
 * Scan the state directory for the first active (non-terminal) workflow.
 * Returns the full state including tasks and worktrees, or null if none found.
 */
export async function findActiveWorkflowState(
  stateDir: string,
): Promise<ActiveWorkflowResult | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch {
    return null;
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  for (const file of stateFiles) {
    const filePath = path.join(stateDir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as WorkflowState;

      if (
        typeof parsed.phase === 'string' &&
        !TERMINAL_PHASES.has(parsed.phase) &&
        typeof parsed.featureId === 'string'
      ) {
        return {
          featureId: parsed.featureId,
          filePath,
          state: parsed,
        };
      }
    } catch {
      // Skip corrupt files
      continue;
    }
  }

  return null;
}

// ─── State Directory Resolution ────────────────────────────────────────────

function resolveStateDir(): string {
  const envDir = process.env.WORKFLOW_STATE_DIR;
  if (envDir) return envDir;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('Cannot determine home directory: HOME and USERPROFILE are both undefined');
  }
  return path.join(home, '.claude', 'workflow-state');
}

// ─── Gate Handlers ─────────────────────────────────────────────────────────

/**
 * Task gate handler for TaskCompleted hook events.
 *
 * Expected stdin shape:
 * ```json
 * {
 *   "hook_event_name": "TaskCompleted",
 *   "task_subject": "...",
 *   "task_output": "...",
 *   "cwd": "/path/to/worktree"
 * }
 * ```
 */
export async function handleTaskGate(
  input: Record<string, unknown>,
): Promise<CommandResult> {
  const validationError = validateCwd(input);
  if (validationError) return validationError;

  return runQualityChecks(input.cwd as string);
}

/**
 * Teammate gate handler for TeammateIdle hook events.
 *
 * When quality checks pass, attempts to update the corresponding task's
 * status to "complete" in the workflow state file, emits a team.task.completed
 * event, and detects newly unblocked follow-up tasks. This is best-effort:
 * failures in state update or event emission do not block the gate.
 *
 * Includes a circuit breaker: after MAX_QUALITY_RETRIES consecutive failures
 * for the same cwd, the gate returns circuitOpen: true to signal the
 * orchestrator should stop retrying.
 *
 * Expected stdin shape:
 * ```json
 * {
 *   "hook_event_name": "TeammateIdle",
 *   "teammate_name": "...",
 *   "cwd": "/path/to/worktree"
 * }
 * ```
 */
export async function handleTeammateGate(
  input: Record<string, unknown>,
): Promise<CommandResult> {
  const validationError = validateCwd(input);
  if (validationError) return validationError;

  const cwd = input.cwd as string;
  const teammateName = typeof input.teammate_name === 'string' ? input.teammate_name : 'unknown';
  const qualityResult = await runQualityChecks(cwd);

  if (qualityResult.error) {
    // Track failure and check circuit breaker
    const circuitOpen = trackQualityFailure(cwd);
    if (circuitOpen) {
      // Emit team.task.failed event on circuit open
      await emitTeamTaskEvent(cwd, teammateName, false, qualityResult.error.message);
      return { ...qualityResult, circuitOpen: true };
    }
    return qualityResult;
  }

  // Quality passed — reset retry counter
  resetQualityRetries(cwd);

  // Attempt state update and event emission (best-effort)
  const completionContext = await updateTaskCompletion(cwd);
  if (completionContext) {
    await emitTeamTaskEvent(
      cwd,
      teammateName,
      true,
      undefined,
      completionContext.taskId,
      completionContext.startedAt,
      completionContext.featureId,
    );

    // Detect newly unblocked tasks
    const unblockedTasks = findUnblockedTasks(completionContext.allTasks, completionContext.taskId);
    if (unblockedTasks.length > 0) {
      return { continue: true, unblockedTasks };
    }
  }

  return { continue: true };
}

// ─── State Bridge ──────────────────────────────────────────────────────────

/** Context returned by updateTaskCompletion for event emission and follow-up detection. */
interface TaskCompletionContext {
  readonly taskId: string;
  readonly startedAt: string | undefined;
  readonly featureId: string;
  readonly allTasks: readonly WorkflowTask[];
}

/**
 * Best-effort update: find the active workflow, match cwd to a worktree entry,
 * mark the corresponding task as complete, and write back. Returns context
 * for event emission if a task was matched, or null otherwise.
 * Silently swallows all errors so the gate is never blocked by state issues.
 */
async function updateTaskCompletion(cwd: string): Promise<TaskCompletionContext | null> {
  try {
    const stateDir = resolveStateDir();
    const active = await findActiveWorkflowState(stateDir);
    if (!active) return null;

    const expectedVersion = active.state._version;

    // Find the worktree entry whose path matches cwd
    const matchingWorktree = Object.values(active.state.worktrees).find(
      (wt) => wt.path === cwd,
    );
    if (!matchingWorktree) return null;

    // Find the corresponding task
    const task = active.state.tasks.find((t) => t.id === matchingWorktree.taskId);
    if (!task) return null;

    // Capture context before mutation
    const context: TaskCompletionContext = {
      taskId: task.id,
      startedAt: task.startedAt,
      featureId: active.featureId,
      allTasks: active.state.tasks,
    };

    // Update task status
    task.status = 'complete';
    task.completedAt = new Date().toISOString();
    active.state._version += 1;

    // CAS check: re-read file and verify version hasn't changed
    const currentRaw = await fs.readFile(active.filePath, 'utf-8');
    const currentState = JSON.parse(currentRaw) as WorkflowState;
    if (currentState._version !== expectedVersion) {
      // Another writer intervened — skip this update (best-effort)
      // Still return context so event can be emitted
      return context;
    }

    // Atomic write: tmp file + rename (with unique suffix to prevent same-process collisions)
    const tmpPath = `${active.filePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(active.state, null, 2));
      await fs.rename(tmpPath, active.filePath);
    } catch {
      // Clean up tmp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    return context;
  } catch {
    // Best-effort: swallow errors so gate is never blocked
    return null;
  }
}

// ─── Team Event Emission ──────────────────────────────────────────────────

/**
 * Lightweight event append for CLI hooks (no full EventStore import).
 * Appends a single JSON line to the JSONL file.
 */
async function appendTeamEvent(
  stateDir: string,
  streamId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const eventFile = path.join(stateDir, `${streamId}.events.jsonl`);
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(eventFile, line, 'utf-8');
}

/**
 * Get changed files in the worktree using git diff.
 */
function getChangedFiles(cwd: string): string[] {
  try {
    const output = execSync('git diff --name-only HEAD~1', {
      cwd,
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Emit a team.task.completed or team.task.failed event to the JSONL event store.
 * Best-effort: failures are silently swallowed.
 */
async function emitTeamTaskEvent(
  cwd: string,
  teammateName: string,
  passed: boolean,
  failureReason?: string,
  taskId?: string,
  startedAt?: string,
  featureId?: string,
): Promise<void> {
  try {
    const stateDir = resolveStateDir();
    const streamId = featureId ?? (await resolveStreamId(stateDir));
    if (!streamId) return;

    if (passed) {
      const filesChanged = getChangedFiles(cwd);
      const durationMs = startedAt
        ? Date.now() - new Date(startedAt).getTime()
        : 0;

      await appendTeamEvent(stateDir, streamId, {
        streamId,
        sequence: Date.now(),
        timestamp: new Date().toISOString(),
        type: 'team.task.completed',
        data: {
          taskId: taskId ?? 'unknown',
          teammateName,
          durationMs: durationMs > 0 ? durationMs : 1,
          filesChanged,
          testsPassed: true,
          qualityGateResults: {},
        },
      });
    } else {
      await appendTeamEvent(stateDir, streamId, {
        streamId,
        sequence: Date.now(),
        timestamp: new Date().toISOString(),
        type: 'team.task.failed',
        data: {
          taskId: taskId ?? 'unknown',
          teammateName,
          failureReason: failureReason ?? 'quality gate failed',
          gateResults: {},
        },
      });
    }
  } catch {
    // Best-effort: swallow errors
  }
}

/**
 * Resolve the stream ID by finding the active workflow.
 */
async function resolveStreamId(stateDir: string): Promise<string | null> {
  const active = await findActiveWorkflowState(stateDir);
  return active?.featureId ?? null;
}

// ─── Follow-up Task Detection ─────────────────────────────────────────────

interface BlockableTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly blockedBy?: string[];
}

/**
 * Find tasks that become unblocked after a task completes.
 * A task is unblocked when ALL its blockers are in 'complete' status.
 */
export function findUnblockedTasks(
  tasks: readonly BlockableTask[],
  completedTaskId: string,
): BlockableTask[] {
  return tasks.filter((task) => {
    if (!task.blockedBy || task.blockedBy.length === 0) return false;
    if (!task.blockedBy.includes(completedTaskId)) return false;
    if (task.status !== 'pending') return false;
    // Check ALL blockers are complete
    return task.blockedBy.every((blockerId) => {
      if (blockerId === completedTaskId) return true;
      const blocker = tasks.find((t) => t.id === blockerId);
      return blocker?.status === 'complete';
    });
  });
}

// ─── Retry Circuit Breaker ────────────────────────────────────────────────

const MAX_QUALITY_RETRIES = 3;

/** Module-level retry counter (persists across calls within same process). */
const qualityRetryCounters = new Map<string, number>();

/**
 * Track quality gate failures per cwd. Returns true if circuit should open.
 */
function trackQualityFailure(cwd: string): boolean {
  const current = (qualityRetryCounters.get(cwd) ?? 0) + 1;
  qualityRetryCounters.set(cwd, current);
  return current >= MAX_QUALITY_RETRIES;
}

/**
 * Reset retry counter on success. Pass '__all__' to clear all counters (for testing).
 */
export function resetQualityRetries(cwd: string): void {
  if (cwd === '__all__') {
    qualityRetryCounters.clear();
  } else {
    qualityRetryCounters.delete(cwd);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractStderr(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'stderr' in err &&
    Buffer.isBuffer((err as { stderr: unknown }).stderr)
  ) {
    return ((err as { stderr: Buffer }).stderr).toString('utf-8').trim();
  }
  return '';
}

function extractStdout(err: unknown): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'stdout' in err &&
    Buffer.isBuffer((err as { stdout: unknown }).stdout)
  ) {
    return ((err as { stdout: Buffer }).stdout).toString('utf-8').trim();
  }
  return '';
}
