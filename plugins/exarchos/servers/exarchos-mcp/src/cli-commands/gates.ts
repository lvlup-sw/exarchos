// ─── Quality Gate CLI Commands ──────────────────────────────────────────────
//
// Gates run at task/teammate lifecycle boundaries to enforce quality standards.
// They execute configurable checks in the task's working directory.
//
// Exit semantics (managed by the CLI framework, not this module):
//   - continue: true  → exit 0 (gate passed, allow continuation)
//   - error returned   → exit 2 (gate blocked, feedback on stderr)

import { execSync } from 'node:child_process';
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

  return runQualityChecks(input.cwd as string);
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
