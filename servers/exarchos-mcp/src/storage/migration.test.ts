import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { WorkflowState } from '../workflow/types.js';
import { SqliteBackend } from './sqlite-backend.js';
import {
  migrateLegacyStateFiles,
  migrateLegacyOutbox,
  cleanupLegacyFiles,
} from './migration.js';

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

    // Assert: original file was renamed to .migrated
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(filePath + '.migrated')).toBe(true);
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
    const result = backend.drainOutbox('my-stream', mockSender);
    expect(result.sent).toBe(2);
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
    // Arrange: create various legacy files
    fs.writeFileSync(path.join(tempDir, 'stream-a.seq'), '{"sequence":5}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.snapshot.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.state.json.migrated'), '{}', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'stream-a.outbox.json'), '[]', 'utf-8');

    // Also create a file that should NOT be removed
    fs.writeFileSync(path.join(tempDir, 'stream-a.events.jsonl'), '', 'utf-8');

    // Act
    await cleanupLegacyFiles(tempDir);

    // Assert: legacy files are gone
    expect(fs.existsSync(path.join(tempDir, 'stream-a.seq'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.snapshot.json'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.state.json.migrated'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'stream-a.outbox.json'))).toBe(false);

    // Assert: events file is still there
    expect(fs.existsSync(path.join(tempDir, 'stream-a.events.jsonl'))).toBe(true);
  });

  it('cleanupLegacyFiles_MissingFiles_NoError', async () => {
    // Act — empty directory, no files to clean up — should not throw
    await cleanupLegacyFiles(tempDir);
  });
});
