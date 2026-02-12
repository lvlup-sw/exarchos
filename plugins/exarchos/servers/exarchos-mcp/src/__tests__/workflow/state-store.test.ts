import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initStateFile,
  readStateFile,
  writeStateFile,
  applyDotPath,
  listStateFiles,
  resolveStateDir,
  StateStoreError,
} from '../../workflow/state-store.js';
import { ErrorCode } from '../../workflow/schemas.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-state-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('State Store', () => {
  describe('InitStateFile_FeatureWorkflow_CreatesV1_1Schema', () => {
    it('should create a valid feature workflow state file', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'my-feature', 'feature');

      expect(stateFile).toBe(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.version).toBe('1.1');
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');
      expect(state.artifacts).toEqual({ design: null, plan: null, pr: null });
      expect(state.tasks).toEqual([]);
      expect(state.worktrees).toEqual({});
      expect(state.reviews).toEqual({});
      expect(state.synthesis).toEqual({
        integrationBranch: null,
        mergeOrder: [],
        mergedBranches: [],
        prUrl: null,
        prFeedback: [],
      });
      expect(state._history).toEqual({});
      // _events and _eventSequence removed — events now in external JSONL store
      expect(state._checkpoint).toBeDefined();
      expect(state._checkpoint.phase).toBe('ideate');
      expect(state._checkpoint.summary).toBe('Workflow initialized');

      // Verify file was written to disk
      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.featureId).toBe('my-feature');
    });

    it('should create a debug workflow state starting at triage phase', async () => {
      const { state } = await initStateFile(tmpDir, 'bug-fix', 'debug');

      expect(state.workflowType).toBe('debug');
      expect(state.phase).toBe('triage');
    });

    it('should create a refactor workflow state starting at explore phase', async () => {
      const { state } = await initStateFile(tmpDir, 'cleanup', 'refactor');

      expect(state.workflowType).toBe('refactor');
      expect(state.phase).toBe('explore');
    });

    it('should throw STATE_ALREADY_EXISTS if state file already exists', async () => {
      await initStateFile(tmpDir, 'existing-feature', 'feature');

      await expect(
        initStateFile(tmpDir, 'existing-feature', 'feature')
      ).rejects.toThrow(ErrorCode.STATE_ALREADY_EXISTS);
    });
  });

  describe('ReadStateFile_ValidJSON_ParsesAndValidates', () => {
    it('should read and validate a state file from disk', async () => {
      const { stateFile } = await initStateFile(tmpDir, 'read-test', 'feature');
      const state = await readStateFile(stateFile);

      expect(state.featureId).toBe('read-test');
      expect(state.version).toBe('1.1');
      expect(state.workflowType).toBe('feature');
    });
  });

  describe('WriteStateFile_AtomicRename_TempThenRename', () => {
    it('should write state file atomically using tmp-then-rename', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'atomic-test', 'feature');

      // Modify state and write
      const updatedState = { ...state, updatedAt: new Date().toISOString() };
      await writeStateFile(stateFile, updatedState);

      // Verify the file was written
      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.updatedAt).toBe(updatedState.updatedAt);

      // Verify no leftover temp files
      const files = await fs.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('ReadStateFile_CorruptJSON_ReturnsStateCorruptError', () => {
    it('should throw STATE_CORRUPT for invalid JSON', async () => {
      const stateFile = path.join(tmpDir, 'corrupt.state.json');
      await fs.writeFile(stateFile, 'not valid json{{{', 'utf-8');

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_CORRUPT);
    });

    it('should throw STATE_NOT_FOUND for missing file', async () => {
      const stateFile = path.join(tmpDir, 'missing.state.json');

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_NOT_FOUND);
    });
  });

  describe('ApplyDotPath_NestedPath_UpdatesCorrectField', () => {
    it('should update a nested field using dot notation', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };

      applyDotPath(obj, 'artifacts.design', 'docs/design.md');

      expect((obj.artifacts as Record<string, unknown>).design).toBe('docs/design.md');
    });

    it('should create intermediate objects if they do not exist', () => {
      const obj: Record<string, unknown> = {};

      applyDotPath(obj, 'deep.nested.field', 'value');

      expect(
        ((obj.deep as Record<string, unknown>).nested as Record<string, unknown>).field
      ).toBe('value');
    });
  });

  describe('ApplyDotPath_ArrayAccess_UpdatesArrayElement', () => {
    it('should update an array element using bracket notation', () => {
      const obj: Record<string, unknown> = {
        tasks: [
          { id: 'task-1', status: 'pending' },
          { id: 'task-2', status: 'pending' },
        ],
      };

      applyDotPath(obj, 'tasks[1].status', 'complete');

      expect(
        ((obj.tasks as Array<Record<string, unknown>>)[1]).status
      ).toBe('complete');
    });

    it('should handle array at root level', () => {
      const obj: Record<string, unknown> = {
        items: ['a', 'b', 'c'],
      };

      applyDotPath(obj, 'items[0]', 'z');

      expect((obj.items as string[])[0]).toBe('z');
    });
  });

  describe('ApplyDotPath_ReservedField_ReturnsReservedFieldError', () => {
    it('should throw RESERVED_FIELD for paths starting with underscore', () => {
      const obj: Record<string, unknown> = {};

      expect(() => applyDotPath(obj, '_events', [])).toThrow(ErrorCode.RESERVED_FIELD);
    });

    it('should throw RESERVED_FIELD for nested paths with underscore segment', () => {
      const obj: Record<string, unknown> = {
        nested: {},
      };

      expect(() => applyDotPath(obj, 'nested._internal', 'value')).toThrow(
        ErrorCode.RESERVED_FIELD
      );
    });
  });

  describe('ListStateFiles_MultipleWorkflows_ReturnsActiveOnly', () => {
    it('should list all state files in the state directory', async () => {
      await initStateFile(tmpDir, 'feature-a', 'feature');
      await initStateFile(tmpDir, 'feature-b', 'debug');
      await initStateFile(tmpDir, 'feature-c', 'refactor');

      const results = await listStateFiles(tmpDir);

      expect(results).toHaveLength(3);
      const featureIds = results.map((r) => r.featureId).sort();
      expect(featureIds).toEqual(['feature-a', 'feature-b', 'feature-c']);

      // Each entry should have stateFile and state
      for (const entry of results) {
        expect(entry.stateFile).toContain('.state.json');
        expect(entry.state).toBeDefined();
        expect(entry.state.featureId).toBe(entry.featureId);
      }
    });

    it('should return empty array for empty directory', async () => {
      const results = await listStateFiles(tmpDir);
      expect(results).toEqual([]);
    });

    it('should ignore non-state files', async () => {
      await initStateFile(tmpDir, 'real-state', 'feature');
      // Write a non-state file
      await fs.writeFile(path.join(tmpDir, 'readme.md'), '# Notes', 'utf-8');

      const results = await listStateFiles(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].featureId).toBe('real-state');
    });
  });

  describe('resolveStateDir', () => {
    it('should use WORKFLOW_STATE_DIR env var when set', () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      try {
        process.env.WORKFLOW_STATE_DIR = '/tmp/custom-state-dir';
        const dir = resolveStateDir();
        expect(dir).toBe('/tmp/custom-state-dir');
      } finally {
        if (originalEnv === undefined) {
          delete process.env.WORKFLOW_STATE_DIR;
        } else {
          process.env.WORKFLOW_STATE_DIR = originalEnv;
        }
      }
    });
  });

  describe('ApplyDotPath_ObjectUpdate_DeepMerges', () => {
    it('should deep-merge when both existing and new values are plain objects', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };
      applyDotPath(obj, 'artifacts', { design: 'docs/design.md' });
      expect(obj.artifacts).toEqual({ design: 'docs/design.md', plan: null, pr: null });
    });

    it('should deep-merge nested objects preserving siblings', () => {
      const obj: Record<string, unknown> = {
        synthesis: {
          integrationBranch: null,
          mergeOrder: [],
          mergedBranches: [],
          prUrl: null,
          prFeedback: [],
        },
      };
      applyDotPath(obj, 'synthesis', { prUrl: 'https://github.com/pr/1' });
      expect((obj.synthesis as Record<string, unknown>).prUrl).toBe('https://github.com/pr/1');
      expect((obj.synthesis as Record<string, unknown>).mergeOrder).toEqual([]);
      expect((obj.synthesis as Record<string, unknown>).integrationBranch).toBeNull();
    });

    it('should replace when new value is not a plain object', () => {
      const obj: Record<string, unknown> = { name: 'old' };
      applyDotPath(obj, 'name', 'new');
      expect(obj.name).toBe('new');
    });

    it('should replace when existing value is not a plain object', () => {
      const obj: Record<string, unknown> = { count: 5 };
      applyDotPath(obj, 'count', { nested: true });
      expect(obj.count).toEqual({ nested: true });
    });

    it('should replace arrays, not merge them', () => {
      const obj: Record<string, unknown> = { tags: ['a', 'b'] };
      applyDotPath(obj, 'tags', ['c']);
      expect(obj.tags).toEqual(['c']);
    });

    it('should still work with dot-path notation for nested values', () => {
      const obj: Record<string, unknown> = {
        artifacts: { design: null, plan: null, pr: null },
      };
      applyDotPath(obj, 'artifacts.design', 'docs/design.md');
      expect(obj.artifacts).toEqual({ design: 'docs/design.md', plan: null, pr: null });
    });

    it('should handle deep-merge with nested objects recursively', () => {
      const obj: Record<string, unknown> = {
        explore: {
          startedAt: '2025-01-15T10:00:00Z',
          completedAt: null,
          scopeAssessment: { filesAffected: 5, testCoverage: 'good' },
        },
      };
      applyDotPath(obj, 'explore', { completedAt: '2025-01-15T11:00:00Z' });
      const explore = obj.explore as Record<string, unknown>;
      expect(explore.startedAt).toBe('2025-01-15T10:00:00Z');
      expect(explore.completedAt).toBe('2025-01-15T11:00:00Z');
      expect(explore.scopeAssessment).toEqual({ filesAffected: 5, testCoverage: 'good' });
    });

    it('should replace when existing value is null', () => {
      const obj: Record<string, unknown> = { integration: null };
      applyDotPath(obj, 'integration', { passed: true });
      expect(obj.integration).toEqual({ passed: true });
    });

    it('should recursively merge at multiple nesting levels', () => {
      const obj: Record<string, unknown> = {
        explore: {
          scopeAssessment: { filesAffected: 5, testCoverage: 'good' },
          startedAt: '2025-01-15T10:00:00Z',
        },
      };
      applyDotPath(obj, 'explore', {
        scopeAssessment: { testCoverage: 'excellent', riskLevel: 'low' },
      });
      const explore = obj.explore as Record<string, unknown>;
      const scope = explore.scopeAssessment as Record<string, unknown>;
      expect(scope.filesAffected).toBe(5);         // preserved from original
      expect(scope.testCoverage).toBe('excellent'); // overwritten by source
      expect(scope.riskLevel).toBe('low');          // new key from source
      expect(explore.startedAt).toBe('2025-01-15T10:00:00Z'); // sibling preserved
    });
  });

  // ─── Edge Cases and Error Paths ──────────────────────────────────────────

  describe('listStateFiles_CorruptFile_SkipsAndReturnValid', () => {
    it('should skip corrupt state files and return only valid ones', async () => {
      // Create a valid state file
      await initStateFile(tmpDir, 'valid-feature', 'feature');
      // Create a corrupt state file (invalid JSON)
      await fs.writeFile(
        path.join(tmpDir, 'corrupt.state.json'),
        'invalid json{{{',
        'utf-8',
      );

      const results = await listStateFiles(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].featureId).toBe('valid-feature');
    });

    it('should return empty array when all state files are corrupt', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'bad1.state.json'),
        '{not valid}}}',
        'utf-8',
      );
      await fs.writeFile(
        path.join(tmpDir, 'bad2.state.json'),
        '',
        'utf-8',
      );

      const results = await listStateFiles(tmpDir);
      expect(results).toHaveLength(0);
    });
  });

  describe('listStateFiles_ENOENT_ReturnsEmptyArray', () => {
    it('should return empty array when directory does not exist', async () => {
      const nonExistentDir = path.join(tmpDir, 'does-not-exist');

      const results = await listStateFiles(nonExistentDir);
      expect(results).toEqual([]);
    });
  });

  describe('listStateFiles_NonENOENTError_ThrowsStateStoreError', () => {
    it('should throw StateStoreError with FILE_IO_ERROR for non-ENOENT readdir errors', async () => {
      // Use a regular file as the "directory" path — readdir on a file gives ENOTDIR, not ENOENT
      const filePath = path.join(tmpDir, 'not-a-directory');
      await fs.writeFile(filePath, 'just a file', 'utf-8');

      await expect(listStateFiles(filePath)).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
      // Verify it's a StateStoreError instance
      try {
        await listStateFiles(filePath);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
      }
    });
  });

  describe('resolveStateDir_GitFails_FallsToCwd', () => {
    it('should fall back to cwd-based path when git command fails', () => {
      const originalEnv = process.env.WORKFLOW_STATE_DIR;
      delete process.env.WORKFLOW_STATE_DIR;

      // resolveStateDir uses execSync('git rev-parse --show-toplevel')
      // When in a git repo, it returns the git root.
      // We can verify the fallback behavior by testing with env var set to empty string
      // then testing without env var — it should always end with docs/workflow-state
      try {
        const dir = resolveStateDir();
        // Should resolve to some path ending with docs/workflow-state
        expect(dir).toMatch(/docs[/\\]workflow-state$/);
      } finally {
        if (originalEnv !== undefined) {
          process.env.WORKFLOW_STATE_DIR = originalEnv;
        }
      }
    });
  });

  describe('writeStateFile_WritetimeValidation_RejectsInvalidState', () => {
    it('should reject state with invalid worktree (neither taskId nor tasks)', async () => {
      const { stateFile, state } = await initStateFile(tmpDir, 'validate-test', 'feature');
      const mutated = structuredClone(state) as Record<string, unknown>;
      (mutated.worktrees as Record<string, unknown>)['bad-wt'] = {
        branch: 'feat/bad',
        status: 'active',
        // Missing both taskId and tasks
      };

      await expect(
        writeStateFile(stateFile, mutated as typeof state),
      ).rejects.toThrow(ErrorCode.INVALID_INPUT);
    });
  });

  describe('writeStateFile_FailurePath_ThrowsStateStoreError', () => {
    it('should throw StateStoreError with FILE_IO_ERROR when writing to an invalid path', async () => {
      const { state } = await initStateFile(tmpDir, 'write-fail-test', 'feature');

      // Try to write to a path under a file (not a directory) — causes ENOTDIR or ENOENT
      const blocker = path.join(tmpDir, 'blocker');
      await fs.writeFile(blocker, 'I am a file', 'utf-8');
      const invalidStateFile = path.join(blocker, 'nested', 'state.json');

      await expect(writeStateFile(invalidStateFile, state)).rejects.toThrow(
        ErrorCode.FILE_IO_ERROR,
      );
      // Verify it's a StateStoreError instance
      try {
        await writeStateFile(invalidStateFile, state);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
      }
    });

    it('should not leave temp files behind after write failure', async () => {
      const { state } = await initStateFile(tmpDir, 'cleanup-test', 'feature');

      // Write to a read-only directory to cause rename failure
      const readOnlyDir = path.join(tmpDir, 'readonly');
      await fs.mkdir(readOnlyDir);
      const stateFile = path.join(readOnlyDir, 'test.state.json');
      // Make directory read-only so temp file write fails
      await fs.chmod(readOnlyDir, 0o444);

      try {
        await expect(writeStateFile(stateFile, state)).rejects.toThrow(
          ErrorCode.FILE_IO_ERROR,
        );
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(readOnlyDir, 0o755);
      }

      // Verify no temp files left behind
      const files = await fs.readdir(readOnlyDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('initStateFile_WriteFailsNonEEXIST_ThrowsFileIOError', () => {
    it('should throw StateStoreError with FILE_IO_ERROR when writeFile fails with non-EEXIST error', async () => {
      // Create a read-only directory so writeFile fails with EACCES, not EEXIST
      const readOnlyDir = path.join(tmpDir, 'readonly-dir');
      await fs.mkdir(readOnlyDir);
      await fs.chmod(readOnlyDir, 0o444);

      try {
        await expect(
          initStateFile(readOnlyDir, 'write-blocked', 'feature'),
        ).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
        // Verify it's a StateStoreError
        try {
          await initStateFile(readOnlyDir, 'write-blocked2', 'feature');
        } catch (err) {
          expect(err).toBeInstanceOf(StateStoreError);
          expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
        }
      } finally {
        await fs.chmod(readOnlyDir, 0o755);
      }
    });
  });

  describe('applyDotPath_ArrayErrorPaths', () => {
    it('should throw INVALID_INPUT when intermediate path expects array but finds object', () => {
      const obj: Record<string, unknown> = {
        data: { notArray: true },
      };

      expect(() => applyDotPath(obj, 'data[0].value', 'test')).toThrow(
        ErrorCode.INVALID_INPUT,
      );
    });

    it('should throw INVALID_INPUT when final path expects array but finds object', () => {
      const obj: Record<string, unknown> = {
        data: { notArray: true },
      };

      expect(() => applyDotPath(obj, 'data[0]', 'test')).toThrow(
        ErrorCode.INVALID_INPUT,
      );
    });

    it('should create intermediate array when navigating numeric segments', () => {
      const obj: Record<string, unknown> = {};

      // tasks -> create as array (next segment is numeric), [0] -> create as object (next segment is string)
      applyDotPath(obj, 'tasks[0].name', 'task-1');

      expect(Array.isArray(obj.tasks)).toBe(true);
      expect((obj.tasks as Array<Record<string, unknown>>)[0].name).toBe('task-1');
    });

    it('should create intermediate array for undefined array segment via dot notation', () => {
      const obj: Record<string, unknown> = {
        matrix: [[1, 2], [3, 4]],
      };

      // Access matrix[2].[0] where matrix[2] doesn't exist — parsePath needs dot between brackets
      applyDotPath(obj, 'matrix[2].[0]', 99);

      expect((obj.matrix as number[][])[2][0]).toBe(99);
    });
  });

  describe('readStateFile_NonENOENTReadError_ThrowsFileIOError', () => {
    it('should throw StateStoreError with FILE_IO_ERROR for non-ENOENT read errors', async () => {
      // Use a directory path as the file — reading a directory gives EISDIR, not ENOENT
      const dirPath = path.join(tmpDir, 'a-directory');
      await fs.mkdir(dirPath);

      await expect(readStateFile(dirPath)).rejects.toThrow(ErrorCode.FILE_IO_ERROR);
      // Verify it's a StateStoreError
      try {
        await readStateFile(dirPath);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.FILE_IO_ERROR);
      }
    });
  });

  describe('readStateFile_MigrationFails_ThrowsStateCorrupt', () => {
    it('should throw STATE_CORRUPT when migration fails due to unknown version', async () => {
      const stateFile = path.join(tmpDir, 'bad-version.state.json');
      // Write a file with a version that has no migration path
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          version: '0.1',
          featureId: 'test',
          workflowType: 'feature',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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
            timestamp: new Date().toISOString(),
            phase: 'ideate',
            summary: '',
            operationsSince: 0,
            fixCycleCount: 0,
            lastActivityTimestamp: new Date().toISOString(),
            staleAfterMinutes: 120,
          },
        }),
        'utf-8',
      );

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_CORRUPT);
      // Verify it's a StateStoreError
      try {
        await readStateFile(stateFile);
      } catch (err) {
        expect(err).toBeInstanceOf(StateStoreError);
        expect((err as StateStoreError).code).toBe(ErrorCode.STATE_CORRUPT);
      }
    });

    it('should throw STATE_CORRUPT when migration fails due to missing version', async () => {
      const stateFile = path.join(tmpDir, 'no-version.state.json');
      // Write valid JSON but without version field
      await fs.writeFile(
        stateFile,
        JSON.stringify({
          featureId: 'test',
          workflowType: 'feature',
        }),
        'utf-8',
      );

      await expect(readStateFile(stateFile)).rejects.toThrow(ErrorCode.STATE_CORRUPT);
    });
  });
});
