import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import { SqliteBackend } from './sqlite-backend.js';

// Mock node:fs/promises to allow intercepting readdir/unlink in cleanupLegacyFiles
// All functions pass through to real implementations by default
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readdir: vi.fn((...args: Parameters<typeof real.readdir>) => real.readdir(...args)),
    unlink: vi.fn((...args: Parameters<typeof real.unlink>) => real.unlink(...args)),
    rename: vi.fn((...args: Parameters<typeof real.rename>) => real.rename(...args)),
  };
});

import * as fsp from 'node:fs/promises';
import {
  migrateLegacyStateFiles,
  migrateLegacyOutbox,
  cleanupLegacyFiles,
} from './migration.js';

const mockedReaddir = vi.mocked(fsp.readdir);
const mockedUnlink = vi.mocked(fsp.unlink);

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'ideate',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  } as WorkflowState;
}

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2024-01-01T00:00:00.000Z',
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
}

// ─── migrateLegacyStateFiles Tests ──────────────────────────────────────────

describe('migrateLegacyStateFiles', () => {
  let backend: SqliteBackend;
  let tempDir: string;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
    tempDir = createTempDir();
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrateLegacyStateFiles_WithStateJSON_MigratesIntoSQLite', async () => {
    // Arrange: write a legacy state file
    const state = makeState({ featureId: 'my-feature', phase: 'plan' });
    const filePath = path.join(tempDir, 'my-feature.state.json');
    fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');

    // Act
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: state was migrated into SQLite
    const retrieved = backend.getState('my-feature');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.featureId).toBe('my-feature');
    expect(retrieved!.phase).toBe('plan');

    // Assert: original file preserved as crash-recovery backup
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('migrateLegacyStateFiles_AlreadyInBackend_SkipsIdempotently', async () => {
    // Arrange: state already exists in backend
    const state = makeState({ featureId: 'existing', phase: 'plan' });
    backend.setState('existing', state);

    // Write a .state.json that would conflict
    const filePath = path.join(tempDir, 'existing.state.json');
    const olderState = makeState({ featureId: 'existing', phase: 'ideate' });
    fs.writeFileSync(filePath, JSON.stringify(olderState), 'utf-8');

    // Act
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: backend still has the original state (not overwritten)
    const retrieved = backend.getState('existing');
    expect(retrieved!.phase).toBe('plan');

    // Assert: file remains untouched
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('migrateLegacyStateFiles_NoLegacyFiles_NoOps', async () => {
    // Act — empty directory
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: no errors and no states
    const states = backend.listStates();
    expect(states).toHaveLength(0);
  });

  it('migrateLegacyStateFiles_CorruptStateJSON_SkipsWithWarning', async () => {
    // Arrange: write a corrupt state file and a valid one
    const corruptPath = path.join(tempDir, 'corrupt-feature.state.json');
    fs.writeFileSync(corruptPath, '{not valid json!!!', 'utf-8');

    const state = makeState({ featureId: 'good-feature', phase: 'delegate' });
    const validPath = path.join(tempDir, 'good-feature.state.json');
    fs.writeFileSync(validPath, JSON.stringify(state), 'utf-8');

    // Act — should not throw
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: only the valid state was migrated
    const states = backend.listStates();
    expect(states).toHaveLength(1);
    expect(states[0].featureId).toBe('good-feature');

    // Corrupt file remains as-is (not renamed to .migrated)
    expect(fs.existsSync(corruptPath)).toBe(true);
  });

  it('migrateLegacyStateFiles_V1_0State_MigratesViaMigrationPipeline', async () => {
    // Arrange: write a v1.0 state file (no _history, _checkpoint)
    const v1_0State = {
      version: '1.0',
      featureId: 'old-feature',
      workflowType: 'feature',
      phase: 'plan',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
    };
    const filePath = path.join(tempDir, 'old-feature.state.json');
    fs.writeFileSync(filePath, JSON.stringify(v1_0State), 'utf-8');

    // Act
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: state was migrated to v1.1 and stored
    const retrieved = backend.getState('old-feature');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.version).toBe('1.1');
    expect(retrieved!._history).toBeDefined();
    expect(retrieved!._checkpoint).toBeDefined();
    // File preserved as backup
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('migrateLegacyStateFiles_VersionlessState_MigratesAsV1_0', async () => {
    // Arrange: write a state file without a version field
    const versionlessState = {
      featureId: 'legacy-feature',
      workflowType: 'feature',
      phase: 'ideate',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifacts: { design: null, plan: null, pr: null },
      tasks: [],
      worktrees: {},
      reviews: {},
      synthesis: {
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      },
    };
    const filePath = path.join(tempDir, 'legacy-feature.state.json');
    fs.writeFileSync(filePath, JSON.stringify(versionlessState), 'utf-8');

    // Act
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert: versionless state was treated as v1.0 and migrated
    const retrieved = backend.getState('legacy-feature');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.version).toBe('1.1');
    expect(retrieved!._checkpoint).toBeDefined();
    // File preserved as backup
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('migrateLegacyStateFiles_MultipleFiles_MigratesAll', async () => {
    // Arrange
    const stateA = makeState({ featureId: 'feature-a', phase: 'ideate' });
    const stateB = makeState({ featureId: 'feature-b', phase: 'plan' });
    fs.writeFileSync(path.join(tempDir, 'feature-a.state.json'), JSON.stringify(stateA), 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'feature-b.state.json'), JSON.stringify(stateB), 'utf-8');

    // Act
    await migrateLegacyStateFiles(backend, tempDir);

    // Assert
    const states = backend.listStates();
    expect(states).toHaveLength(2);
    const featureIds = states.map((s) => s.featureId);
    expect(featureIds).toContain('feature-a');
    expect(featureIds).toContain('feature-b');
  });
});

// ─── migrateLegacyOutbox Tests ──────────────────────────────────────────────

describe('migrateLegacyOutbox', () => {
  let backend: SqliteBackend;
  let tempDir: string;

  beforeEach(() => {
    backend = new SqliteBackend(':memory:');
    backend.initialize();
    tempDir = createTempDir();
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrateLegacyOutbox_WithOutboxJSON_MigratesEntries', async () => {
    // Arrange: write a legacy outbox file with entries
    const entries = [
      makeEvent({ streamId: 'my-stream', sequence: 1, type: 'workflow.started' }),
      makeEvent({ streamId: 'my-stream', sequence: 2, type: 'task.assigned' }),
    ];
    const filePath = path.join(tempDir, 'my-stream.outbox.json');
    fs.writeFileSync(filePath, JSON.stringify(entries), 'utf-8');

    // Act
    await migrateLegacyOutbox(backend, tempDir);

    // Assert: entries were added to outbox — verify by draining
    const sentEvents: unknown[] = [];
    const mockSender = {
      appendEvents: async (_streamId: string, events: unknown[]) => {
        sentEvents.push(...events);
        return { accepted: events.length, streamVersion: 1 };
      },
    };
    const result = await backend.drainOutbox('my-stream', mockSender);
    expect(result.sent).toBe(2);

    // Assert: original file renamed to .migrated
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(filePath + '.migrated')).toBe(true);
  });

  it('migrateLegacyOutbox_NoOutboxFiles_NoOps', async () => {
    // Act — empty directory
    await migrateLegacyOutbox(backend, tempDir);

    // Assert: no errors
  });
});

// ─── cleanupLegacyFiles Tests ───────────────────────────────────────────────

describe('cleanupLegacyFiles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('cleanupLegacyFiles_RemovesSeqAndSnapshotAndOutboxFiles', async () => {
    // Arrange: create various legacy files (post-migration state)
    fs.writeFileSync(path.join(tempDir, 'stream-a.seq'), '{"sequence":5}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.snapshot.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.state.json.migrated'), '{}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.outbox.json.migrated'), '[]', 'utf-8');

    // Also create a file that should NOT be removed
    fs.writeFileSync(path.join(tempDir, 'stream-a.events.jsonl'), '', 'utf-8');

    // Act
    await cleanupLegacyFiles(tempDir);

    // Assert: legacy files are gone
    expect(fs.existsSync(path.join(tempDir, 'stream-a.seq'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.snapshot.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.state.json.migrated'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.outbox.json.migrated'))).toBe(false);

    // Assert: events file is still there
    expect(fs.existsSync(path.join(tempDir, 'stream-a.events.jsonl'))).toBe(true);
  });

  it('cleanupLegacyFiles_MissingFiles_NoError', async () => {
    // Act — empty directory, no files to clean up — should not throw
    await cleanupLegacyFiles(tempDir);
  });
});

// ─── T-15: cleanupLegacyFiles failure recovery ──────────────────────────────

describe('cleanupLegacyFiles failure recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CleanupLegacyFiles_DirectoryNotFound_ReturnsEarly', async () => {
    // Call with a nonexistent directory — should return cleanly (ENOENT is caught)
    const nonexistentDir = path.join(os.tmpdir(), 'nonexistent-cleanup-dir-' + Date.now());
    await expect(cleanupLegacyFiles(nonexistentDir)).resolves.toBeUndefined();
  });

  it('CleanupLegacyFiles_ReadPermissionDenied_ThrowsError', async () => {
    // Mock readdir to throw EACCES (non-ENOENT error should be rethrown)
    const eaccessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    mockedReaddir.mockRejectedValueOnce(eaccessError);

    await expect(cleanupLegacyFiles('/some/dir')).rejects.toThrow('Permission denied');
  });

  it('CleanupLegacyFiles_FileUnlinkPermissionDenied_ThrowsError', async () => {
    // Mock readdir to return files that match legacy patterns
    mockedReaddir.mockResolvedValueOnce(['stream.seq', 'stream.snapshot.json'] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

    // Mock unlink to throw EACCES on the first file
    const eaccessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    mockedUnlink.mockRejectedValueOnce(eaccessError);

    await expect(cleanupLegacyFiles('/some/dir')).rejects.toThrow('Permission denied');
  });

  it('CleanupLegacyFiles_FileAlreadyDeleted_ContinuesSilently', async () => {
    // Mock readdir to return multiple legacy files
    mockedReaddir.mockResolvedValueOnce([
      'a.seq',
      'b.snapshot.json',
      'c.state.json.migrated',
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

    // First file throws ENOENT (already deleted), others succeed
    const enoentError = Object.assign(new Error('File not found'), { code: 'ENOENT' });
    mockedUnlink
      .mockRejectedValueOnce(enoentError)  // a.seq — ENOENT, continue
      .mockResolvedValueOnce(undefined)      // b.snapshot.json — success
      .mockResolvedValueOnce(undefined);     // c.state.json.migrated — success

    // Should not throw — ENOENT is caught and processing continues
    await expect(cleanupLegacyFiles('/some/dir')).resolves.toBeUndefined();

    // All three files should have been attempted for unlink
    expect(mockedUnlink).toHaveBeenCalledTimes(3);
  });

  it('CleanupLegacyFiles_PartialSuccess_SomeFilesRemain', async () => {
    // Mock readdir to return two legacy files
    mockedReaddir.mockResolvedValueOnce([
      'first.seq',
      'second.snapshot.json',
    ] as unknown as Awaited<ReturnType<typeof fsp.readdir>>);

    // First file deletes successfully, second throws EACCES
    const eaccessError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    mockedUnlink
      .mockResolvedValueOnce(undefined)       // first.seq — success
      .mockRejectedValueOnce(eaccessError);   // second.snapshot.json — EACCES

    // Should throw because EACCES is rethrown
    await expect(cleanupLegacyFiles('/some/dir')).rejects.toThrow('Permission denied');

    // First file was attempted (and succeeded)
    expect(mockedUnlink).toHaveBeenCalledWith(path.join('/some/dir', 'first.seq'));
    // Second file was attempted (and failed)
    expect(mockedUnlink).toHaveBeenCalledWith(path.join('/some/dir', 'second.snapshot.json'));
  });
});

// ─── T22: JSONL→SQLite migration orchestrator failure path ────────────────
//
// The orchestrator iterates legacy `*.events.jsonl` files in the
// workflow-state directory, claims the migration_lock, and routes each
// file through `importJsonlFile`. On any unrecoverable fault during a
// file import, the orchestrator MUST:
//   (a) emit a `migration.failed` event with `{ reason,
//       partialFilesImported, partialEventsImported }`,
//   (b) leave the migration_lock row claimed (DR-12: failure leaves the
//       lock for operator inspection), and
//   (c) surface a structured error to the caller.

describe('Migration_FailureMidImport_EmitsMigrationFailedAndKeepsLock', () => {
  let stateDir: string;
  let backend: SqliteBackend;

  beforeEach(() => {
    stateDir = createTempDir();
    backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
    backend.initialize();
  });

  afterEach(() => {
    backend.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('fault-injected import failure leaves migration_lock claimed and emits migration.failed', async () => {
    // ─── Fixture: 2 stream files, one we will sabotage ────────────────────
    const goodStream = 'stream-good-22';
    const badStream = 'stream-bad-22';
    fs.writeFileSync(
      path.join(stateDir, `${goodStream}.events.jsonl`),
      JSON.stringify({
        streamId: goodStream,
        sequence: 1,
        type: 'workflow.started',
        timestamp: '2026-01-01T00:00:00.000Z',
        eventId: 'a1',
        data: {},
        idempotencyKey: 'k-good-1',
      }) + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(stateDir, `${badStream}.events.jsonl`),
      JSON.stringify({
        streamId: badStream,
        sequence: 1,
        type: 'task.assigned',
        timestamp: '2026-01-01T00:00:00.000Z',
        eventId: 'a2',
        data: {},
        idempotencyKey: 'k-bad-1',
      }) + '\n',
      'utf-8',
    );

    // ─── Fault-inject: corrupt the bad-stream file by truncating mid-line ─
    // We build a synthetic fault by passing a bad-stream content that the
    // importer can read but the underlying append will reject. Simpler
    // approach used here: the orchestrator accepts a `failOnFile` test
    // hook that throws when invoked for a particular basename. The hook
    // simulates an unrecoverable fault during import.
    const { runJsonlToSqliteMigration } = await import('./migration.js');
    const { readMigrationLockState } = await import('./migration-lock.js');

    const result = await runJsonlToSqliteMigration({
      stateDir,
      backend,
      // Test-only fault hook: throws when invoked for the bad-stream file.
      _testOnlyFaultHook: (filePath: string) => {
        if (filePath.includes(badStream)) {
          throw new Error('synthetic-import-fault');
        }
      },
    });

    // The orchestrator MUST surface a structured failure, NOT throw or
    // swallow. The shape lets lifecycle.ts (T57) translate the failure
    // into the correct startup error.
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.reason).toMatch(/synthetic-import-fault|failed/);
    expect(result.partialFilesImported).toBeGreaterThanOrEqual(0);
    expect(result.partialEventsImported).toBeGreaterThanOrEqual(0);

    // ─── Lock state: claimed (NOT released) ───────────────────────────────
    const lockState = readMigrationLockState(backend);
    expect(lockState).not.toBeNull();
    if (lockState === null) return;
    expect(lockState.state).toBe('claimed');
    expect(lockState.releasedAt).toBeNull();

    // ─── migration.failed event emitted on `__migration__` stream ─────────
    const events = backend.queryEvents('__migration__');
    const failed = events.filter((e) => e.type === 'migration.failed');
    expect(failed).toHaveLength(1);
    const fd = failed[0].data as {
      reason: string;
      partialFilesImported: number;
      partialEventsImported: number;
    };
    expect(typeof fd.reason).toBe('string');
    expect(fd.reason.length).toBeGreaterThan(0);
    expect(fd.partialFilesImported).toBeGreaterThanOrEqual(0);
    expect(fd.partialEventsImported).toBeGreaterThanOrEqual(0);

    // ─── No migration.completed event ─────────────────────────────────────
    const completed = events.filter((e) => e.type === 'migration.completed');
    expect(completed).toHaveLength(0);
  });
});
