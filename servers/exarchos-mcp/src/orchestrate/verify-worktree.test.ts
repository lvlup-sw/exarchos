// ─── Verify Worktree Action Tests ─────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolResult } from '../format.js';

vi.mock('node:fs');

import { handleVerifyWorktree } from './verify-worktree.js';

const STATE_DIR = '/tmp/test-verify-worktree';

beforeEach(() => {
  vi.restoreAllMocks();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function mockDirExists(dirPath: string): void {
  vi.mocked(fs.existsSync).mockImplementation((p) => p === dirPath);
  vi.mocked(fs.statSync).mockImplementation((p) => {
    if (p === dirPath) {
      return { isDirectory: () => true } as fs.Stats;
    }
    throw new Error(`ENOENT: no such file or directory, stat '${String(p)}'`);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleVerifyWorktree', () => {
  it('returns passed when path is inside a worktree', async () => {
    const worktreePath = '/foo/.worktrees/task-001/bar';
    mockDirExists(worktreePath);

    const result: ToolResult = await handleVerifyWorktree({ cwd: worktreePath }, STATE_DIR);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; path: string; message: string };
    expect(data.passed).toBe(true);
    expect(data.path).toBe(worktreePath);
    expect(data.message).toContain('worktree');
  });

  it('returns failed when path is not in a worktree', async () => {
    const regularPath = '/foo/bar';
    mockDirExists(regularPath);

    const result: ToolResult = await handleVerifyWorktree({ cwd: regularPath }, STATE_DIR);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; path: string; message: string };
    expect(data.passed).toBe(false);
    expect(data.path).toBe(regularPath);
    expect(data.message).toContain('Not in a worktree');
  });

  it('returns error for non-existent directory', async () => {
    const badPath = '/does/not/exist';
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result: ToolResult = await handleVerifyWorktree({ cwd: badPath }, STATE_DIR);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('does not exist');
  });

  it('defaults to process.cwd() when no cwd arg provided', async () => {
    const fakeCwd = '/home/user/.worktrees/task-002/project';
    vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    mockDirExists(fakeCwd);

    const result: ToolResult = await handleVerifyWorktree({}, STATE_DIR);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; path: string };
    expect(data.passed).toBe(true);
    expect(data.path).toBe(fakeCwd);
  });

  it('resolves relative paths correctly', async () => {
    const resolvedPath = path.resolve('relative/path');
    mockDirExists(resolvedPath);

    const result: ToolResult = await handleVerifyWorktree({ cwd: 'relative/path' }, STATE_DIR);

    expect(result.success).toBe(true);
    const data = result.data as { path: string };
    expect(path.isAbsolute(data.path)).toBe(true);
  });
});
