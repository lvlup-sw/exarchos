/**
 * Orchestrate action that verifies the working directory is inside a git worktree.
 * The test is a substring match: the resolved path must contain `.worktrees/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import type { ToolResult } from '../../format.js';

interface VerifyWorktreeArgs {
  readonly cwd?: string;
}

/**
 * Checks `args.cwd`, or the process directory when it is absent.
 * The path is converted to POSIX form first, so the substring test and the returned path are the same on Windows.
 */
export async function handleVerifyWorktree(
  args: VerifyWorktreeArgs,
  _stateDir: string,
): Promise<ToolResult> {
  const rawPath = args.cwd ?? process.cwd();
  const resolvedPath = toPosix(path.resolve(rawPath));

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
