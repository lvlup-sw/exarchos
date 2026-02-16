// ─── Quality Gate CLI Commands ──────────────────────────────────────────────
//
// Gates run at task/teammate lifecycle boundaries to enforce quality standards.
// They execute configurable checks in the task's working directory.
//
// Exit semantics (managed by the CLI framework, not this module):
//   - continue: true  → exit 0 (gate passed, allow continuation)
//   - error returned   → exit 2 (gate blocked, feedback on stderr)

import { execSync } from 'node:child_process';
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
 * status to "complete" in the workflow state file. This is best-effort:
 * failures in state update do not block the gate.
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
  const qualityResult = await runQualityChecks(cwd);

  // Only attempt state update when quality checks pass
  if (!qualityResult.error) {
    await updateTaskCompletion(cwd);
  }

  return qualityResult;
}

// ─── State Bridge ──────────────────────────────────────────────────────────

/**
 * Best-effort update: find the active workflow, match cwd to a worktree entry,
 * mark the corresponding task as complete, and write back. Silently swallows
 * all errors so the gate is never blocked by state issues.
 */
async function updateTaskCompletion(cwd: string): Promise<void> {
  try {
    const stateDir = resolveStateDir();
    const active = await findActiveWorkflowState(stateDir);
    if (!active) return;

    // Find the worktree entry whose path matches cwd
    const matchingWorktree = Object.values(active.state.worktrees).find(
      (wt) => wt.path === cwd,
    );
    if (!matchingWorktree) return;

    // Find the corresponding task
    const task = active.state.tasks.find((t) => t.id === matchingWorktree.taskId);
    if (!task) return;

    // Update task status
    task.status = 'complete';
    task.completedAt = new Date().toISOString();
    active.state._version += 1;

    // Write updated state back
    await fs.writeFile(active.filePath, JSON.stringify(active.state, null, 2));
  } catch {
    // Best-effort: swallow errors so gate is never blocked
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
