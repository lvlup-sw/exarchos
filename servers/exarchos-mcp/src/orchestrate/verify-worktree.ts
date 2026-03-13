// ─── Verify Worktree Orchestrate Action ──────────────────────────────────────
//
// Verifies that the current or provided working directory is inside a git
// worktree (path contains '.worktrees/').
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolResult } from '../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface VerifyWorktreeArgs {
  readonly cwd?: string;
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleVerifyWorktree(
  args: VerifyWorktreeArgs,
  _stateDir: string,
): Promise<ToolResult> {
  const rawPath = args.cwd ?? process.cwd();
  const resolvedPath = path.resolve(rawPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Directory does not exist: ${resolvedPath}`,
      },
    };
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Path is not a directory: ${resolvedPath}`,
      },
    };
  }

  const inWorktree = resolvedPath.includes('.worktrees/');

  if (inWorktree) {
    return {
      success: true,
      data: {
        passed: true,
        path: resolvedPath,
        message: `OK: Working in worktree at ${resolvedPath}`,
      },
    };
  }

  return {
    success: true,
    data: {
      passed: false,
      path: resolvedPath,
      message: `Not in a worktree! Current directory: ${resolvedPath}. Expected: path containing '.worktrees/'. ABORTING — DO NOT proceed with file modifications.`,
    },
  };
}
