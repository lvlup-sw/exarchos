// ─── Extract Fix Tasks Tests ─────────────────────────────────────────────────
//
// Tests for the TypeScript port of extract-fix-tasks.sh.
// Mocks node:fs to avoid real filesystem access.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock node:fs ────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { handleExtractFixTasks } from './extract-fix-tasks.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStateWithReviews(findings: unknown[]) {
  return JSON.stringify({
    reviews: {
      review1: {
        findings,
      },
    },
    tasks: [],
  });
}

function makeStateWithWorktreeAndReviews(
  findings: unknown[],
  worktrees: Array<{ worktree: string; branch?: string }>,
) {
  return JSON.stringify({
    reviews: {
      review1: { findings },
    },
    tasks: worktrees.map((w) => ({
      id: 'task-1',
      worktree: w.worktree,
      branch: w.branch ?? 'feature-branch',
    })),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleExtractFixTasks', () => {
  it('extracts fix tasks from state file reviews', () => {
    const findings = [
      { file: 'src/foo.ts', line: 10, description: 'Missing null check', severity: 'HIGH' },
      { file: 'src/bar.ts', line: 25, description: 'Unused import', severity: 'LOW' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; count: number };
    expect(data.count).toBe(2);
    expect(data.tasks).toEqual([
      { id: 'fix-001', file: 'src/foo.ts', line: 10, worktree: null, description: 'Missing null check', severity: 'HIGH' },
      { id: 'fix-002', file: 'src/bar.ts', line: 25, worktree: null, description: 'Unused import', severity: 'LOW' },
    ]);
  });

  it('uses external review report when provided', () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });
    const reportJson = JSON.stringify({
      findings: [
        { file: 'src/baz.ts', line: 5, description: 'Type error', severity: 'MEDIUM' },
      ],
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === '/tmp/state.json') return stateJson;
      if (String(path) === '/tmp/report.json') return reportJson;
      throw new Error(`Unexpected path: ${String(path)}`);
    });

    const result = handleExtractFixTasks({
      stateFile: '/tmp/state.json',
      reviewReport: '/tmp/report.json',
    });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; count: number };
    expect(data.count).toBe(1);
    expect(data.tasks[0]).toMatchObject({
      id: 'fix-001',
      file: 'src/baz.ts',
      description: 'Type error',
    });
  });

  it('returns empty array when no findings exist', () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; count: number };
    expect(data.count).toBe(0);
    expect(data.tasks).toEqual([]);
  });

  it('returns error when state file not found', () => {
    mockExistsSync.mockReturnValue(false);

    const result = handleExtractFixTasks({ stateFile: '/tmp/missing.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('returns error when state file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = handleExtractFixTasks({ stateFile: '/tmp/bad.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
  });

  it('returns error when multiple worktrees exist with findings', () => {
    const findings = [
      { file: 'src/foo.ts', line: 1, description: 'Issue', severity: 'HIGH' },
    ];
    const stateJson = makeStateWithWorktreeAndReviews(findings, [
      { worktree: '/worktree/a' },
      { worktree: '/worktree/b' },
    ]);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_WORKTREE');
  });

  it('maps findings to single worktree when only one exists', () => {
    const findings = [
      { file: 'src/foo.ts', line: 10, description: 'Bug', severity: 'HIGH' },
    ];
    const stateJson = makeStateWithWorktreeAndReviews(findings, [
      { worktree: '/worktree/only' },
    ]);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ worktree: string | null }>; count: number };
    expect(data.tasks[0].worktree).toBe('/worktree/only');
  });

  it('generates zero-padded fix task IDs', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      description: `Finding ${i + 1}`,
      severity: 'MEDIUM',
    }));
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }>; count: number };
    expect(data.tasks[0].id).toBe('fix-001');
    expect(data.tasks[8].id).toBe('fix-009');
    expect(data.tasks[9].id).toBe('fix-010');
    expect(data.tasks[11].id).toBe('fix-012');
  });

  it('defaults severity to MEDIUM when not provided', () => {
    const findings = [
      { file: 'src/foo.ts', line: 1, description: 'No severity' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ severity: string }> };
    expect(data.tasks[0].severity).toBe('MEDIUM');
  });

  it('defaults line to null when not provided', () => {
    const findings = [
      { file: 'src/foo.ts', description: 'No line number', severity: 'LOW' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ line: number | null }> };
    expect(data.tasks[0].line).toBe(null);
  });

  it('returns error when review report not found', () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockImplementation((path: unknown) => {
      return String(path) === '/tmp/state.json';
    });
    mockReadFileSync.mockReturnValue(stateJson);

    const result = handleExtractFixTasks({
      stateFile: '/tmp/state.json',
      reviewReport: '/tmp/missing-report.json',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('returns error when review report contains invalid JSON', () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === '/tmp/state.json') return stateJson;
      return 'broken json!!!';
    });

    const result = handleExtractFixTasks({
      stateFile: '/tmp/state.json',
      reviewReport: '/tmp/bad-report.json',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
  });
});
