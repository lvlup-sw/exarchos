import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { backupStateFile, migrateState, CURRENT_VERSION } from './migration.js';

describe('backupStateFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'migration-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BackupStateFile_ExistingFile_CreatesBackCopy', async () => {
    const stateFile = path.join(tempDir, 'test.state.json');
    const content = JSON.stringify({ version: '1.0', featureId: 'test' });
    await writeFile(stateFile, content, 'utf-8');

    await backupStateFile(stateFile);

    const backupContent = await readFile(`${stateFile}.bak`, 'utf-8');
    expect(backupContent).toBe(content);
  });

  it('BackupStateFile_ReturnsBackupPath', async () => {
    const stateFile = path.join(tempDir, 'test.state.json');
    await writeFile(stateFile, '{}', 'utf-8');

    const result = await backupStateFile(stateFile);

    expect(result).toBe(`${stateFile}.bak`);
  });

  it('BackupStateFile_MissingFile_ThrowsError', async () => {
    const stateFile = path.join(tempDir, 'nonexistent.state.json');

    await expect(backupStateFile(stateFile)).rejects.toThrow();
  });
});

describe('MigrateState_MissingVersion_TreatedAsV1_0', () => {
  it('should treat missing version as v1.0 and migrate to current', () => {
    const versionless = {
      featureId: 'test-feature',
      workflowType: 'feature',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T10:30:00Z',
      phase: 'ideate',
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

    const result = migrateState(versionless) as Record<string, unknown>;

    expect(result.version).toBe(CURRENT_VERSION);
    expect(result._history).toEqual({});
    expect(result._checkpoint).toBeDefined();
    const history = result._migrationHistory as Array<{ from: string; to: string }>;
    expect(history).toHaveLength(1);
    expect(history[0].from).toBe('1.0');
    expect(history[0].to).toBe('1.1');
  });
});

describe('Migration Metadata', () => {
  it('MigrateState_V1_0ToV1_1_AddsMigrationHistory', () => {
    const v1_0 = {
      version: '1.0',
      featureId: 'test-feature',
      workflowType: 'feature',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T10:30:00Z',
      phase: 'ideate',
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

    const result = migrateState(v1_0) as Record<string, unknown>;

    const history = result._migrationHistory as Array<{ from: string; to: string; timestamp: string }>;
    expect(history).toBeDefined();
    expect(Array.isArray(history)).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0].from).toBe('1.0');
    expect(history[0].to).toBe('1.1');
    expect(typeof history[0].timestamp).toBe('string');
    // Verify it's a valid ISO date
    expect(new Date(history[0].timestamp).toISOString()).toBe(history[0].timestamp);
  });

  it('MigrateState_AlreadyCurrent_NoMigrationHistory', () => {
    const v1_1 = {
      version: '1.1',
      featureId: 'test-feature',
      workflowType: 'feature',
      createdAt: '2025-01-15T10:00:00Z',
      updatedAt: '2025-01-15T10:30:00Z',
      phase: 'ideate',
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
      _history: {},
      _checkpoint: {
        timestamp: '2025-01-15T10:30:00Z',
        phase: 'ideate',
        summary: '',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp: '2025-01-15T10:30:00Z',
        staleAfterMinutes: 120,
      },
    };

    const result = migrateState(v1_1) as Record<string, unknown>;

    // Should NOT have _migrationHistory since no migration was applied
    expect(result._migrationHistory).toBeUndefined();
  });
});
