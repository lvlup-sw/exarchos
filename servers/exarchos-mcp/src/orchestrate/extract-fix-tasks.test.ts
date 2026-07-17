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
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { handleExtractFixTasks } from './extract-fix-tasks.js';
import { EventStore } from '../event-store/store.js';

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
  it('extracts fix tasks from state file reviews', async () => {
    const findings = [
      { file: 'src/foo.ts', line: 10, description: 'Missing null check', severity: 'HIGH' },
      { file: 'src/bar.ts', line: 25, description: 'Unused import', severity: 'LOW' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; count: number };
    expect(data.count).toBe(2);
    expect(data.tasks).toEqual([
      { id: 'fix-001', file: 'src/foo.ts', line: 10, worktree: null, description: 'Missing null check', severity: 'HIGH' },
      { id: 'fix-002', file: 'src/bar.ts', line: 25, worktree: null, description: 'Unused import', severity: 'LOW' },
    ]);
  });

  it('uses external review report when provided', async () => {
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

    const result = await handleExtractFixTasks({
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

  it('returns empty array when no findings exist', async () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: unknown[]; count: number };
    expect(data.count).toBe(0);
    expect(data.tasks).toEqual([]);
  });

  it('returns error when state file not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/missing.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('returns error when state file contains invalid JSON', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = await handleExtractFixTasks({ stateFile: '/tmp/bad.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
  });

  it('returns error when multiple worktrees exist with findings', async () => {
    const findings = [
      { file: 'src/foo.ts', line: 1, description: 'Issue', severity: 'HIGH' },
    ];
    const stateJson = makeStateWithWorktreeAndReviews(findings, [
      { worktree: '/worktree/a' },
      { worktree: '/worktree/b' },
    ]);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('AMBIGUOUS_WORKTREE');
  });

  it('maps findings to single worktree when only one exists', async () => {
    const findings = [
      { file: 'src/foo.ts', line: 10, description: 'Bug', severity: 'HIGH' },
    ];
    const stateJson = makeStateWithWorktreeAndReviews(findings, [
      { worktree: '/worktree/only' },
    ]);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ worktree: string | null }>; count: number };
    expect(data.tasks[0]!.worktree).toBe('/worktree/only');
  });

  it('generates zero-padded fix task IDs', async () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      description: `Finding ${i + 1}`,
      severity: 'MEDIUM',
    }));
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string }>; count: number };
    expect(data.tasks[0]!.id).toBe('fix-001');
    expect(data.tasks[8]!.id).toBe('fix-009');
    expect(data.tasks[9]!.id).toBe('fix-010');
    expect(data.tasks[11]!.id).toBe('fix-012');
  });

  it('defaults severity to MEDIUM when not provided', async () => {
    const findings = [
      { file: 'src/foo.ts', line: 1, description: 'No severity' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ severity: string }> };
    expect(data.tasks[0]!.severity).toBe('MEDIUM');
  });

  it('defaults line to null when not provided', async () => {
    const findings = [
      { file: 'src/foo.ts', description: 'No line number', severity: 'LOW' },
    ];
    const stateJson = makeStateWithReviews(findings);

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({ stateFile: '/tmp/state.json' });

    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ line: number | null }> };
    expect(data.tasks[0]!.line).toBe(null);
  });

  it('returns error when review report not found', async () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockImplementation((path: unknown) => {
      return String(path) === '/tmp/state.json';
    });
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handleExtractFixTasks({
      stateFile: '/tmp/state.json',
      reviewReport: '/tmp/missing-report.json',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('returns error when review report contains invalid JSON', async () => {
    const stateJson = JSON.stringify({ reviews: {}, tasks: [] });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path: unknown) => {
      if (String(path) === '/tmp/state.json') return stateJson;
      return 'broken json!!!';
    });

    const result = await handleExtractFixTasks({
      stateFile: '/tmp/state.json',
      reviewReport: '/tmp/bad-report.json',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
  });

  // ─── Fileless resolution: MCP-only workflow ────────────────────────────
  //
  // INV-1: the event store is the sole source of truth. An MCP-only workflow
  // has no `.state.json` stamp; findings (in state.reviews[*].findings) and
  // worktree info (in state.tasks) must resolve from the event-store
  // projection via featureId + eventStore.

  it('FilelessMcpOnly_ResolvesFindingsFromEventStore', async () => {
    mockExistsSync.mockReturnValue(false);

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'extract-fix-fileless-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const featureId = 'fileless-fix';
    await eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    // reviews[*].findings + tasks land on the projection via state.patched.
    await eventStore.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          reviews: {
            review1: {
              findings: [
                { file: 'src/foo.ts', line: 10, description: 'Missing null check', severity: 'HIGH' },
              ],
            },
          },
          tasks: [{ id: 'task-1', worktree: '/worktree/only', branch: 'feat/x' }],
        },
      },
    });

    const result = await handleExtractFixTasks({ featureId, eventStore });

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    // Must NOT fail with FILE_NOT_FOUND / PARSE_ERROR.
    expect(result.success).toBe(true);
    const data = result.data as { tasks: Array<{ id: string; file: string; worktree: string | null }>; count: number };
    expect(data.count).toBe(1);
    expect(data.tasks[0]).toMatchObject({
      id: 'fix-001',
      file: 'src/foo.ts',
      worktree: '/worktree/only',
    });
  });

  // ─── Both sources provided: explicit-stateFile error handling ──────────
  //
  // Regression for the silent-swallow bug: when BOTH stateFile and
  // featureId + eventStore are supplied, a malformed explicit stateFile must
  // surface PARSE_ERROR rather than being silently ignored (resolveWorkflowState
  // catches the JSON error and falls back to the event store). A *missing*
  // stateFile, by contrast, is an optional freshness hint and must fall back.

  it('BothProvided_MalformedStateFile_SurfacesParseError', async () => {
    // File exists but is unparseable → configuration error, not a fallback.
    mockExistsSync.mockImplementation((p) => p === '/tmp/bad.json');
    mockReadFileSync.mockReturnValue('{ not valid json');

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'extract-fix-both-bad-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const result = await handleExtractFixTasks({
      stateFile: '/tmp/bad.json',
      featureId: 'both-bad',
      eventStore,
    });

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PARSE_ERROR');
  });

  it('BothProvided_MissingStateFile_FallsBackToEventStore', async () => {
    // A missing explicit stateFile is not an error when the event store can
    // resolve it (INV-1). The handler must fall back, not return FILE_NOT_FOUND.
    mockExistsSync.mockReturnValue(false);

    const eventStoreDir = await fsPromises.mkdtemp(
      nodePath.join(tmpdir(), 'extract-fix-both-missing-'),
    );
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const featureId = 'both-missing';
    await eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await eventStore.append(featureId, {
      type: 'state.patched',
      data: {
        patch: {
          reviews: {
            review1: {
              findings: [
                { file: 'src/bar.ts', line: 5, description: 'Off-by-one', severity: 'MEDIUM' },
              ],
            },
          },
          tasks: [{ id: 'task-1', worktree: '/worktree/solo', branch: 'feat/y' }],
        },
      },
    });

    const result = await handleExtractFixTasks({
      stateFile: '/tmp/missing.json',
      featureId,
      eventStore,
    });

    eventStore.close();
    await fsPromises.rm(eventStoreDir, { recursive: true, force: true });

    expect(result.success).toBe(true);
    const data = result.data as { count: number; tasks: Array<{ file: string }> };
    expect(data.count).toBe(1);
    expect(data.tasks[0]!.file).toBe('src/bar.ts');
  });
});
